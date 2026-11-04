# Code Review Agent

A self-contained, CodeRabbit-style code reviewer that runs in **any** CI. The
review is performed by an **opencode** agent (read-only, provider-agnostic) and
the thread lifecycle is handled by deterministic Node code — no external review
SaaS, no runtime npm dependencies.

One CLI (`bin/cra.js`) does everything:

| Command | What it does |
| --- | --- |
| `cra review` | Reviews a PR/MR (GitHub, GitLab) or any diff (other CIs): diff → existing threads → model analysis → post · resolve · summary → report files → exit code. |
| `cra analyze` | Reviews the current branch or working tree locally, with no platform side effects. |

Platform adapters live in `src/platforms/` (`github`, `gitlab`, or `none`), and
report formats in `src/reporters.js`: SARIF 2.1.0, GitLab Code Quality,
Markdown, JSON.

## Documentation

| Doc | What it covers |
| --- | --- |
| [Setup](docs/SETUP.md) | GitHub consumer setup: classic PAT, secrets, workflow, branch protection. |
| [CI integrations](docs/CI-INTEGRATIONS.md) | Platform capability matrix, GitLab/Jenkins/Bitbucket/Azure templates, token permissions, `--fail-on` semantics, env var reference. |
| [Architecture](docs/ARCHITECTURE.md) | Module design, data flow, security model, degrade paths. |
| [Thread lifecycle](docs/THREAD-LIFECYCLE.md) | The merge gate, delta algorithm, dedupe, resolve rules. |
| [E2E results](docs/E2E-RESULTS.md) | End-to-end verification against a real repo with planted bugs. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common problems and how to diagnose them. |
| [Development](docs/DEVELOPMENT.md) | Tests, local runs, the local skill. |

## How it works

```
diff range → existing threads (adapter) → [Analyzer] opencode run (read-only)
          → findings.json → [Lifecycle] computeDelta (deterministic)
          → post new inline threads · resolve fixed threads
          → upsert one summary comment · (optional) commit status
          → report files (SARIF / Code Quality / Markdown / JSON) → exit code
```

- **Analyzer** (`src/analyzer.js`) — generates an `opencode.json` for a
  dedicated `code-reviewer` agent (deny-by-default: no `bash`, `edit`,
  `webfetch`, `websearch`) and runs `opencode run --format json`. Its output is
  extracted, normalized and validated against `schema/findings.schema.json`.
  No model call happens when the diff is empty.
- **Lifecycle** (`src/lifecycle.js`) — never calls a model and never executes
  comment text. It matches normalized string keys, computes what to post, what
  to keep open and what to resolve.
- **Adapters** (`src/platforms/*`) — the only code that talks to a platform.
  They retry `429`/`5xx`/network errors with backoff, honour `Retry-After`,
  paginate every list endpoint, and never log tokens.
- **Reporters** (`src/reporters.js`) — pure functions from findings to report
  files.

Splitting the model stage from the lifecycle stage is deliberate: the lifecycle
is repeatable and unit-testable without burning tokens, the cost is bounded to
one call per push that touches code, and the prompt-injection boundary stays
outside the model.

### Merge gating (thread resolution)

On GitHub, the gate is the **Require conversation resolution before merging**
branch-protection rule: unresolved review threads block merge. When a dev
pushes fixes, the workflow re-runs, the agent re-reviews, and threads whose
issue is gone are **auto-resolved**. If a dev replies and resolves a thread
manually, the agent **never reopens or re-posts it**.

On GitLab the equivalent is the project setting **Merge requests → All threads
must be resolved**; inline threads are MR discussions. On Jenkins, Bitbucket and
Azure there is no adapter, so the gate is `--fail-on` (job/step/build failure).

Auto-resolve is deliberately conservative — see
[`docs/THREAD-LIFECYCLE.md`](docs/THREAD-LIFECYCLE.md).

## Quick start

### GitHub Actions

1. Add the provider key secret, e.g. `DEEPSEEK_API_KEY`.
2. Optional but recommended for auto-resolve: a **classic** PAT with the `repo`
   scope, stored as `CODE_REVIEW_TOKEN` (see *Why a PAT?*).
3. Copy `example/.github/workflows/code-review.yml`:

   ```yaml
   name: Code Review
   on:
     pull_request:
       types: [opened, synchronize, reopened]
   permissions:
     contents: read
     pull-requests: write
   jobs:
     code-review:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             fetch-depth: 0
             ref: ${{ github.event.pull_request.head.sha }}
             persist-credentials: false
         - uses: anglesen1120/code-review-agent@v1
           with:
             api-key: ${{ secrets.DEEPSEEK_API_KEY }}
             github-token: ${{ secrets.CODE_REVIEW_TOKEN }}
             bot-login: <your-github-username>
             fail-on: critical   # optional: fail the job on open Criticals
   ```

   Leave `github-token` unset (and drop `bot-login`) if the bot should post
   threads but **never auto-resolve them**.
4. Enable branch protection on the default branch: **Require a pull request
   before merging** and **Require conversation resolution before merging**. If
   you set `set-status: true`, also require the `code-review-agent` status check
   and grant `statuses: write`.

### GitLab CI

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/anglesen1120/code-review-agent/<tag-or-sha>/ci/gitlab/code-review.gitlab-ci.yml'
```

Replace `<tag-or-sha>` with a release tag or commit SHA that contains the
template (the `v1` tag predates it), never a moving branch: a remote include is
code that runs with your CI variables. The same applies to `ref:` when the
template lives in another project.

Add masked CI/CD variables `CRA_API_KEY` and `GITLAB_TOKEN` (project or group
access token, role Developer+, scope `api`; `CI_JOB_TOKEN` cannot post MR
discussions). The template runs on merge-request pipelines and stores the Code
Quality report. Details in
[`docs/CI-INTEGRATIONS.md`](docs/CI-INTEGRATIONS.md).

### Docker / any other CI

The image `ghcr.io/anglesen1120/code-review-agent:latest` ships `cra` on `PATH`
(non-root uid 10001, `WORKDIR /workspace`, entrypoint `cra`). Pin it by version
tag or digest in CI — `:latest` is mutable, so a re-pull can change what runs
against your repository:

```bash
# Pin the tag (or use @sha256:<digest>); :latest is mutable.
docker run --rm -v "$PWD:/workspace" -w /workspace \
  -e CRA_API_KEY=<provider-key> \
  ghcr.io/anglesen1120/code-review-agent:latest \
  review --platform none --base origin/main --fail-on critical \
    --sarif cra.sarif --markdown cra-report.md
```

Templates for Jenkins, Bitbucket Pipelines and Azure Pipelines are in `ci/`.
Without a platform adapter, findings appear in the log, the Markdown report and
the SARIF file, and `--fail-on` is the gate.

## Why a PAT? (GitHub auto-resolve)

GitHub only lets **real user accounts** call `resolveReviewThread`. The built-in
`GITHUB_TOKEN` (the `github-actions` app) and fine-grained PATs can **post**
review threads but **cannot resolve** them: both return HTTP 403
(`Resource not accessible by integration` / `... by personal access token`).

Auto-resolving threads the agent previously flagged therefore requires a
**classic PAT with the `repo` scope**. With a PAT the threads are authored by
**you**, so set `bot-login` to your username. Without a PAT the threads are
authored by `github-actions`; they still block merge, the agent still avoids
re-posting, but nobody (agent included) can auto-resolve them from CI.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | — | Provider API key for the analyzer (`CRA_API_KEY`). |
| `github-token` | no | `github.token` | Token used to post/resolve. A **classic PAT (`repo` scope)** is required for auto-resolve. |
| `base-url` | no | `https://opencode.ai/zen/go/v1` | OpenAI-compatible endpoint (`CRA_BASE_URL`). |
| `model` | no | `go/deepseek-v4.1-flash` | `provider/model` for the analyzer (`CRA_MODEL`). |
| `diff-scope` | no | `""` | Extra comma-separated pathspecs to exclude (`CRA_EXCLUDE`). |
| `set-status` | no | `false` | Set the `code-review-agent` commit status (`CRA_SET_STATUS`); needs `statuses: write`. |
| `bot-login` | no | `github-actions` | Identity whose threads the agent manages (`BOT_LOGIN`). |
| `fail-on` | no | `none` | `none` \| `critical` \| `warning`. Fails the step on open issues of that severity; with anything but `none` a failed analysis also fails. |
| `max-diff-bytes` | no | `250000` | Diff budget; whole files beyond it are skipped and listed in the summary. |
| `sarif-file` | no | `""` | Write a SARIF 2.1.0 report to this path. |
| `opencode-version` | no | `1.18.18` | `opencode-ai` npm version the action installs. |

## Outputs

| Output | Description |
| --- | --- |
| `findings-count` | Total findings (all severities) for this run. |
| `unresolved-count` | Open Critical/Warning threads remaining after this run. |
| `review-id` | GitHub review id created this run, if any. |
| `analysis-failed` | `true` when the analyzer could not produce valid findings. |

CLI exit codes: `0` ok · `1` gate failed, nothing could be delivered (no thread
posted, existing threads unreadable, commit status could not be set), or the
whole diff exceeded the budget and nothing was reviewed · `2`
usage/configuration error.

## Findings schema

`schema/findings.schema.json` is the single source of truth. Each finding has
`severity` (`Critical` | `Warning` | `Info`), `category`, `file`, `line`
(new-file line, 1-based), `title`, `description`, `suggestion`, and optional
`startLine`/`endLine`.

- **Critical** — security, data loss, crashes, broken core flows.
- **Warning** — bugs, races, performance, anti-patterns, missing validation.
- **Info** — style/minor; **never** posted as a thread, only in the summary.

The analyzer caps output at 20 findings (severity-first). Findings are only
posted inline when their line exists inside a diff hunk; everything else goes to
the summary, and non-Info findings outside the diff still count for `--fail-on`.
The reviewer prompt (`prompts/reviewer-system.md`) encodes the rubric, the
untrusted-input rule and a .NET/Clean Architecture checklist for .NET repos.

## Security model

The review is **advisory**. It is not a security control and not an adversarial
boundary: a pull request can contain instructions that make the model report
nothing, and a model can miss a real vulnerability. Run it alongside human review
and deterministic scanners (SAST, dependency and secret scanning); never make
it the only check before merge.

The diff is **untrusted input**: a PR can contain text that tries to steer the
reviewer. The design assumes it does.

- **Deny-by-default analyzer agent.** The generated `opencode.json` starts with
  `"*": "deny"` and re-allows only `read`, `glob`, `grep` and `todowrite`.
  `bash`, `edit`, `webfetch`, `websearch`, `task`, `skill`, `question`,
  `doom_loop` and `lsp` stay denied, so there is no shell and no exfiltration
  channel. The config also sets `autoupdate: false`, `share: "disabled"`,
  `snapshot: false`, `lsp: false` and `permission.lsp: "deny"`.
- **Hardened snapshot.** `cra review` exports the head commit with `git archive`
  into a fresh private directory (`mkdtemp`, mode 0700) **outside** the
  checkout, runs `git init -q` inside it so the analyzer's worktree is the
  snapshot itself, and deletes the directory at the end of the run. After the
  export every symlink is removed (and counted in the summary notes), so a
  committed link cannot point the model at `$HOME`, `/etc` or the checkout.
  There is no `.git` from the checkout (its `.git/config` can hold the CI
  token), and untracked, ignored and `export-ignore` files are absent.
- **Read restrictions.** Reads are limited to the analysis root, minus `.env`,
  `.env.*` (except `.env.example`), `.git/`, `*.pem`, `*id_rsa*` and `*.p12`.
  `external_directory` is denied except for the scratch directory that holds the
  diff and `existing_threads.json`; `/proc`, `$HOME`, the original checkout and
  runner credentials stay closed. Verified live against opencode 1.18.18: reads
  of `.git/config`, `.env`, `~/.zshrc` and `grep`/`glob` on `/etc` are refused.
- **Child environment allow-list.** The analyzer spawns opencode with a fixed
  allow-list of variables and forwards **no** inherited `OPENCODE_*` variable:
  a parent `OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION`,
  `OPENCODE_CONFIG_DIR` or `OPENCODE_AUTO_SHARE` would otherwise override the
  hardened config (verified with opencode 1.18.18: `OPENCODE_CONFIG_CONTENT`
  flipped `share` back to `auto`). It sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`,
  `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1` and
  `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, plus `CRA_API_KEY` and
  `OPENCODE_CONFIG`. CI tokens (`GITHUB_TOKEN`, `GITLAB_TOKEN`) are **never**
  passed to the model process, and the API key plus any
  `TOKEN`/`KEY`/`SECRET`/`PASSWORD` environment value (trimmed, per-line,
  JSON-escaped and proxy-credential forms included) is replaced with
  `[REDACTED]` in the attempt log, the stderr/event tails and returned error
  messages. The `events.jsonl` / `opencode.err` files left in the scratch dir
  are **not** redacted: treat that directory as sensitive and let the CI
  artifact rules drop it.
- **Repository config is ignored.** `OPENCODE_DISABLE_PROJECT_CONFIG=1` stops
  the consumer repo's `opencode.json` / `AGENTS.md` from being loaded at all.
- **Model text is neutralized and bounded.** Before anything reaches a PR,
  `@mentions` are broken with a zero-width space, `<!--` is escaped, and a line
  whose first non-space character is `/` gets a zero-width space inserted before
  the slash so GitLab cannot execute it as a quick action. Neutralization is
  fence-aware: lines inside a CommonMark fenced block are left byte-identical
  (suggestions stay copy-pasteable; GitLab only scans paragraphs for quick
  actions), while an unterminated fence gets a closing line so the agent markers
  are never swallowed. Summary notes (skipped files, dropped findings, adapter
  errors) are neutralized on every line. Control characters are stripped and
  `<!--` is escaped everywhere, including fences. Model text printed to
  stdout/stderr has CI workflow commands (`::…`, `##vso[…]`, `##[…]`) defused
  and ANSI/control characters stripped, so a finding cannot inject commands into
  the job log. Written report files are unaffected. Field lengths are capped
  (title 200, description/suggestion 4000 characters, truncated with `…`), the
  summary body
  is held under 59000 characters with an explicit "N finding(s) omitted" note,
  finding paths with control characters or newlines are dropped, and link labels
  are code spans with `[`/`]` percent-encoded so a filename cannot forge a link.
- **The lifecycle never executes text.** Thread dedupe and resolution compare
  normalized keys only; comment bodies are data, not instructions.
- **Fail closed.** An opencode process that exits non-zero (or is killed) is a
  failed analysis even if it printed parseable JSON. A failed analysis posts and
  resolves nothing, keeps the previous reviewed-SHA marker, and fails the run
  when `--fail-on` is not `none`. Delivery failures are always fatal: no thread
  posted, existing threads unreadable, or a commit status that could not be set
  with `--set-status` exits `1` after the report files are written.
- **Partial reviews stay visible.** Files skipped by `--max-diff-bytes` are
  named in the summary and their threads stay open — an unreviewed file is not
  evidence that an issue was fixed. When the whole diff is over budget nothing
  is posted or resolved, the summary says the diff was not reviewed, and the run
  exits `1` regardless of `--fail-on`.
- **Local working-tree caveat.** `cra analyze` without `--base` reviews the live
  working tree, not a snapshot: `grep` can still reach `.git`, and
  `--exclude`/`CRA_EXCLUDE` limits what is reviewed but does not sandbox the
  filesystem. Use it for local review only; CI runs should use `cra review`.
- **Workflow hygiene.** Use `persist-credentials: false` on `actions/checkout`
  so the checkout credential is not left in `.git/config` while untrusted code
  is analysed. Never run this workflow on `pull_request_target` with a checkout
  of the PR head: that combination exposes repository secrets to code the PR
  author controls. Pin the image by tag or digest and a remote include by
  tag/SHA (see [`docs/CI-INTEGRATIONS.md`](docs/CI-INTEGRATIONS.md)).
- **Token scope.** Give the platform token the minimum listed in
  [`docs/CI-INTEGRATIONS.md`](docs/CI-INTEGRATIONS.md#token-permissions). The
  API key is only ever read from the environment and written into the generated
  opencode config by name (`{env:CRA_API_KEY}`), never into the repo or logs.

## Local usage

From any repo, review the working tree (no platform, no threads):

```bash
cd /path/to/consumer-repo
CRA_API_KEY=... node /path/to/code-review-agent/bin/cra.js analyze
# findings at .review/findings.json, report printed to stdout
```

Or review a branch against a base:

```bash
CRA_API_KEY=... node /path/to/code-review-agent/bin/cra.js analyze --base origin/main
```

`opencode` must be on `PATH` (`npm install -g opencode-ai@1.18.18`); the Docker
image already has it. `--sarif`, `--codequality`, `--markdown` and `--json`
write report files from any command, and `--dry-run` prints the post/resolve
plan without touching a platform.

The bundled skill (`skills/code-review/SKILL.md`) wraps `cra analyze` in an
interactive review with an optional fix-review cycle.

## Development

- `npm test` — `node --test` over `tests/` (schema, diff parsing, lifecycle,
  adapters, reporters, analyzer extraction; no network, no LLM).
- Local dry-run — `cra analyze` as above and inspect `findings.json`; only
  added/modified lines should be anchored.
- E2E — a throwaway GitHub repo with planted bugs; see
  [docs/E2E-RESULTS.md](docs/E2E-RESULTS.md).

## Risks & limitations

- Only threads authored by the configured bot identity that carry the agent's
  marker are ever touched. Dev-authored threads are never modified.
- Auto-resolve requires evidence: the analysis must have succeeded, the issue
  must not be re-reported, and either the platform marks the thread outdated or
  its file changed since the last reviewed commit (the reviewed SHA is stored in
  the summary comment; without one, all PR files count as changed).
- Report files and the merge gate are independent: a job can be green while
  threads remain open unless you pass `--fail-on` or enable the platform's
  thread-resolution setting.
- Repository config (`opencode.json`, `AGENTS.md`) is ignored during analysis,
  and its content is treated as untrusted data.
- Cost: one analyzer call per push that touches code (plus one retry when the
  output is invalid). Empty or fully-excluded diffs skip the model entirely.
- The model is non-deterministic: two runs on the same diff can produce
  different wording, which is why thread matching is fuzzy by design.

## License

MIT
