# Architecture

How the agent is built and why it is split this way. Aimed at maintainers and
anyone extending the tool.

## Overview

One CLI, one pipeline, any CI:

```
diff range (src/diff.js)
      ↓
existing threads ← platform adapter (src/platforms/*)
      ↓
[Analyzer] opencode run --format json (src/analyzer.js) → findings.json
      ↓
[Lifecycle] computeDelta (src/lifecycle.js) → post · keep · resolve
      ↓
summary comment · optional commit status · report files (src/reporters.js)
      ↓
exit code
```

| Stage | Module | What it does | Deterministic? |
| --- | --- | --- | --- |
| Resolve platform | `src/platforms/index.js` | `auto`/explicit platform detection; returns an adapter or `null` for `none`. | yes |
| Diff | `src/diff.js` | Three-dot git diff, exclusions, byte budget, hunk index, changed files between commits. | yes |
| Fetch | `src/platforms/github.js`, `gitlab.js` | Reads the bot's existing threads and the last reviewed SHA from the summary comment. | yes |
| Analyze | `src/analyzer.js` | Generates the opencode config, runs the model, extracts and validates findings. The only LLM stage. | no |
| Lifecycle | `src/lifecycle.js` | Decides what to post, keep open or resolve; renders the summary; sanitizes model text. | yes |
| Write | adapter + `src/reporters.js` | Posts threads, resolves, upserts the summary, sets status, writes report files. | yes |

Why the split: the lifecycle must be repeatable and unit-testable without
tokens, cost is bounded to one model call per push that touches code, and the
prompt-injection boundary stays outside the model.

## Repository layout

```
code-review-agent/
├── action.yml                    # GitHub composite action (installs opencode, runs bin/cra.js)
├── bin/cra.js                    # CLI: `review` and `analyze`, flags, env, exit codes
├── src/
│   ├── analyzer.js               # opencode config + run + findings extraction
│   ├── diff.js                   # git diff, exclusions, capDiff, parseUnifiedDiff
│   ├── lifecycle.js              # delta, dedupe, gate, markdown, sanitize, markers
│   ├── reporters.js              # SARIF / Code Quality / Markdown
│   ├── validate.js               # schema validation + normalization (single enforcement point)
│   └── platforms/
│       ├── index.js              # platform resolution + base inference for non-adapter CIs
│       ├── github.js             # GitHub REST + GraphQL adapter
│       └── gitlab.js             # GitLab REST adapter
├── prompts/reviewer-system.md    # reviewer rubric for the opencode agent
├── schema/findings.schema.json   # canonical findings schema
├── tests/                        # node:test suites (no network, no LLM)
├── ci/                           # GitLab / Jenkins / Bitbucket / Azure templates
├── skills/code-review/SKILL.md   # local interactive skill (same analyzer)
├── Dockerfile                    # ghcr.io/anglesen1120/code-review-agent
└── example/.github/workflows/code-review.yml
```

Zero runtime npm dependencies: global `fetch`, `node:fs`, `node:child_process`,
`node:util` only. Node ≥ 20.

## Diff stage (`src/diff.js`)

1. Base/head resolution order: explicit `--base`/`--head`, then the platform
   context, then `inferBaseRef(env)` for CIs without an adapter
   (`BITBUCKET_PR_DESTINATION_BRANCH`, `CHANGE_TARGET`,
   `SYSTEM_PULLREQUEST_TARGETBRANCH`, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`,
   `GITHUB_BASE_REF` → `origin/<branch>`).
2. Shallow clones: `ensureCommits` fetches missing revisions and fails with a
   clear message (exit 2) when it cannot, instead of silently diffing the wrong
   range.
3. `git diff --no-color -U5 <base>...<head> -- . <excludes>`; lockfiles,
   `dist/`, `obj/`, `bin/`, `node_modules/`, minified bundles and maps are always
   excluded, plus `--exclude`/`CRA_EXCLUDE` pathspecs.
4. **Diff budget.** `capDiff` keeps a prefix of complete files up to
   `--max-diff-bytes` (default 250000) and never truncates a hunk. Skipped files
   are named in the summary notes, and their existing threads are kept open — an
   unreviewed file is not evidence that a finding was fixed. When the **whole**
   diff is over budget, nothing is posted or resolved, the summary says the diff
   was not reviewed (never "no code changes"), the reviewed-SHA marker does not
   advance, and the run exits `1` regardless of `--fail-on`.
5. `parseUnifiedDiff` builds `Map<path, Map<newLine, {type, oldLine}>>` — the
   only lines that can anchor an inline comment. GitLab additionally needs the
   old-side line for context lines, hence `oldLine`.

`cra analyze` without a base diffs `HEAD` against the working tree; with `--base`
it diffs `base...HEAD`.

## Fetch stage (adapters)

The adapter returns `{ threads, lastReviewedSha }`.

- Only threads whose **root comment** is authored by the bot identity and whose
  body contains the agent marker (`<!-- code-review-agent -->`) are returned.
  `title`/`severity` are parsed back out of that body.
- `lastReviewedSha` is read from the summary comment marker
  (`<!-- code-review-agent:reviewed-sha=<sha> -->`).
- GitHub uses GraphQL `reviewThreads` (paginated) and REST issue comments; the
  Actions token identity is accepted as both `github-actions` and
  `github-actions[bot]`. GitLab uses `GET /user` plus MR discussions and notes;
  GitLab has no outdated flag, so it is always `false`.
- Any failure to read existing threads exits `1`: proceeding without knowing
  the previous threads would duplicate or wrongly resolve them.

## Analyzer (`src/analyzer.js`)

1. Generates `opencode.json` in the scratch dir: an OpenAI-compatible provider
   block (`base-url`, `model`, key referenced as `{env:CRA_API_KEY}`) and a
   `code-reviewer` agent with **deny-by-default** permissions. Allowed: `read`,
   `glob`, `grep`, `todowrite`, plus `external_directory` for the scratch dir.
   Denied: everything else, including `bash`, `edit`, `webfetch`, `websearch`,
   `task`, `skill`, `question`, `doom_loop` and `lsp`. Reads deny `.env`,
   `.env.*` (except `.env.example`), `.git/`, `*.pem`, `*id_rsa*`, `*.p12`.
   The config also sets `autoupdate: false`, `share: "disabled"`,
   `snapshot: false`, `lsp: false` and `permission.lsp: "deny"` (all verified
   against opencode 1.18.18). `provider.npm` stays the exact string
   `@ai-sdk/openai-compatible`: that version matches it to pick the native
   adapter, so a pinned `pkg@version` spec is rejected.
2. Spawns `opencode run --agent code-reviewer --format json --model …` with a
   **child environment allow-list** (`childEnv`): no CI tokens, no inherited
   `OPENCODE_*` variable (a parent `OPENCODE_CONFIG_CONTENT` or
   `OPENCODE_PERMISSION` would override the hardened config), only
   `CRA_API_KEY`, `OPENCODE_CONFIG` and runtime/proxy/TLS variables, plus
   `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`,
   `OPENCODE_DISABLE_LSP_DOWNLOAD=1` and `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`.
3. `extractFindings` joins the `text` events and tries, in order: the whole
   text, each fenced block, each balanced `{…}` span. The first candidate that
   normalizes and validates wins.
4. **Retry / degrade.** One retry with a stricter "output ONLY JSON"
   instruction. If that fails too, the analyzer returns `error` (no throw); the
   caller decides what that means — see below. A non-zero exit or signal is a
   failed attempt **even when stdout carried valid JSON**; the error reads
   `analysis failed: …` (as opposed to `analysis produced invalid findings: …`
   when the process exits 0 with unusable output).
5. Empty diff → no model call at all.

The API key and every non-empty environment value whose name matches
`/(TOKEN|KEY|SECRET|PASSWORD)/i` are replaced with `[REDACTED]` in the attempt
log, stderr/event tails and returned errors. Matching also covers the trimmed and
per-line form of multi-line values, their JSON-escaped form, and
`user:password` inside `HTTPS_PROXY`/`https_proxy`; longest values are replaced
first, and tails are scrubbed before the last N lines are cut. The
`events.jsonl` and `opencode.err` files written to the scratch dir are **not**
redacted.

Timeout: `CRA_ANALYZE_TIMEOUT_MS` (default 15 min) per attempt, enforced with
`SIGKILL`.

## Lifecycle (`src/lifecycle.js`)

Pure functions; no I/O, no model, no execution of comment text.

- `threadKey(f) = "<file>:<line>:<normalizedTitle>"`; `normalizeTitle`
  lowercases, collapses whitespace and strips trailing punctuation.
- `matchThread` order: exact key → same `path:line` with a similar title →
  same path with a similar title within 30 lines (or any line if the thread is
  outdated). Exact-key matches include resolved threads, so a dev-resolved
  thread is **never re-posted**.
- `computeDelta(findings, threads, changedFiles)` — only Critical and Warning
  become threads. For every open thread whose issue is not re-reported:
  - resolve it when `thread.isOutdated || changedFiles.includes(thread.path)`;
  - otherwise leave it open for a human.

  `changedFiles` is "files changed since the last reviewed commit":
  `changedFilesBetween(lastReviewedSha, head)`. When there is no previous
  reviewed SHA (first run, or a summary without the marker) or that SHA is
  unreachable (force-push), the CLI falls back to **all files changed in the
  PR**. A re-run on the same head SHA resolves nothing except threads the
  platform marks outdated.
- `gateFails(severities, failOn)` — `critical` matches Critical; `warning`
  matches Critical or Warning.
- `sanitize` breaks `@mentions`, escapes HTML comments and prefixes a line whose
  first non-space character is `/` with a zero-width space (GitLab quick
  actions), before model text is rendered into a thread, summary, note or the
  Markdown report. It is fence-aware: CommonMark fenced blocks in finding text
  are left byte-identical, and an unterminated fence gets a closing line so the
  agent markers that follow are not swallowed. Summary notes are neutralized on
  every line. Control characters and `<!--` are handled everywhere, including
  inside fences.
- `normalizePath` drops a finding whose path contains control characters or
  newlines; `normalizeFindings` caps title at 200 and description/suggestion at
  4000 characters (truncated with `…`), and `markdownSummary` holds the body
  under 59000 characters with an "_N finding(s) omitted…_" note. Summary link
  labels are code spans with `[`/`]` percent-encoded, so a filename cannot forge
  a link.
- `markdownSummary` writes the summary marker, the reviewed-SHA marker, counts,
  per-severity lists, notes and the merge-gate line.

## CLI orchestration (`bin/cra.js`)

1. Parse flags/env (`resolveOptions`); invalid values exit `2` with usage.
2. Create the adapter (`null` for `none`); a missing platform token or MR
   context exits `2`.
3. Diff, cap, index; fetch existing threads (exit `1` on failure). The analysis
   snapshot is a private `mkdtemp` directory outside the checkout with its own
   `git init`, symlinks removed after the export, deleted at the end of the run;
   scratch files stay in the out-dir (`.review` for `analyze`, `.cra` on GitLab,
   `$RUNNER_TEMP/cra` when set, otherwise a private temp dir).
4. Analyze.
5. **A failed analysis posts nothing and resolves nothing.** The existing
   threads keep blocking the merge, the summary records the failure and points
   at the job log, the reviewed-SHA marker keeps its previous value (or is
   omitted), and `--fail-on` (when not `none`) exits `1` — fail closed. An
   empty-findings result is only trusted when the analysis succeeded.
6. Findings are split by anchor: those whose line is inside a diff hunk become
   inline threads; the rest go to the **summary only** (non-Info ones are listed
   in the notes and still count for the gate). Findings in files skipped by the
   diff budget never resolve a thread, and a fully skipped diff resolves
   nothing and exits `1`.
7. Post, then resolve, then compute the gate from **actual outcomes** (posted
   threads, threads that failed to resolve), not from the plan. A matched thread
   is gated at the current finding's severity, not only the stale severity parsed
   from the existing thread body.
8. Upsert one summary comment (idempotent via marker); optionally set the
   `code-review-agent` commit status (failure when the analysis failed or the
   gate matches, using `warning` semantics when `--fail-on none`). If the status
   call fails, the reports are still written and the run exits `1`.
9. Write report files and outputs: `--sarif`, `--codequality`, `--markdown`,
   `--json`, `GITHUB_STEP_SUMMARY`, `GITHUB_OUTPUT`, plus `result.json` and
   `findings.json` in the scratch dir. Model text printed to the console is
   neutralized for CI workflow commands.

Exit codes: `0` ok · `1` gate failed, analysis failed with `--fail-on` set, no
thread could be posted, existing threads could not be read, the commit status
could not be delivered, or the whole diff exceeded the budget and nothing was
reviewed · `2` usage/configuration error.

## Security model

- The review is advisory, not a security control: an injected PR can make the
  model report nothing, so it complements human review and deterministic
  scanners rather than replacing them.
- The analyzer is deny-by-default and read-only; the diff and the repository are
  treated as untrusted data.
- The model process never sees CI tokens: the child env is an allow-list that
  also drops inherited `OPENCODE_*` variables.
- Consumer repo config (`opencode.json`, `AGENTS.md`) is not loaded.
- The snapshot is a private temp dir with `git init`, symlinks removed, and no
  checkout `.git` or untracked files.
- Model text is sanitized before posting (mentions, HTML comments, quick
  actions) and neutralized on the console; markers cannot be forged.
- The lifecycle never interprets comment text — only normalized keys.
- Adapters never put tokens in URLs and redact them from error messages.
- Threads are posted with the platform token, from the parent process only.

## Cost

- One model call per push that touches code, plus at most one retry.
- Empty or fully-excluded diffs skip the model.
- Findings are capped at 20, severity-first; normalized findings over the cap
  are dropped and listed in the summary notes.
- `--max-diff-bytes`, `--exclude`, `--model` and `--base-url` are the cost knobs.

## Non-goals / boundaries

- The agent never checks out, builds or runs the consumer's code. It reads the
  diff and repository files for context only.
- No platform adapter exists for Jenkins, Bitbucket or Azure; those CIs get
  report files and an exit code, not inline comments.
- Only bot-authored, marker-bearing threads are managed; human threads are never
  touched.
- Any OpenAI-compatible endpoint works via `--base-url`/`--model`.
