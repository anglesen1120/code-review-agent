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
   are named in the summary notes, so a partial review is visible rather than
   silent.
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
   `glob`, `grep`, `lsp`, `todowrite`. Denied: everything else, including
   `bash`, `edit`, `webfetch`, `websearch`, `task`, `skill`, `question`.
   Reads deny `.env`, `.env.*` (except `.env.example`), `.git/`, `*.pem`,
   `*id_rsa*`, `*.p12`;
   `external_directory` allows only the scratch dir.
2. Spawns `opencode run --agent code-reviewer --format json --model …` with a
   **child environment allow-list** (`childEnv`): no CI tokens, only
   `CRA_API_KEY`, `OPENCODE_CONFIG` and runtime/proxy/TLS variables, plus
   `OPENCODE_DISABLE_PROJECT_CONFIG=1` so consumer repo config cannot steer the
   model.
3. `extractFindings` joins the `text` events and tries, in order: the whole
   text, each fenced block, each balanced `{…}` span. The first candidate that
   normalizes and validates wins.
4. **Retry / degrade.** One retry with a stricter "output ONLY JSON"
   instruction. If that fails too, the analyzer returns `error` (no throw); the
   caller decides what that means — see below.
5. Empty diff → no model call at all.

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
- `sanitize` breaks `@mentions` and escapes HTML comments before model text is
  rendered into a thread or summary.
- `markdownSummary` writes the summary marker, the reviewed-SHA marker, counts,
  per-severity lists, notes and the merge-gate line.

## CLI orchestration (`bin/cra.js`)

1. Parse flags/env (`resolveOptions`); invalid values exit `2` with usage.
2. Create the adapter (`null` for `none`); a missing platform token or MR
   context exits `2`.
3. Diff, cap, index; fetch existing threads (exit `1` on failure).
4. Analyze.
5. **A failed analysis posts nothing and resolves nothing.** The existing
   threads keep blocking the merge, the summary records the failure and points
   at the job log, and `--fail-on` (when not `none`) exits `1` — fail closed.
   An empty-findings result is only trusted when the analysis succeeded.
6. Findings are split by anchor: those whose line is inside a diff hunk become
   inline threads; the rest go to the **summary only** (non-Info ones are listed
   in the notes and still count for the gate).
7. Post, then resolve, then compute the gate from **actual outcomes** (posted
   threads, threads that failed to resolve), not from the plan.
8. Upsert one summary comment (idempotent via marker); optionally set the
   `code-review-agent` commit status (failure when the analysis failed or the
   gate matches, using `warning` semantics when `--fail-on none`).
9. Write report files and outputs: `--sarif`, `--codequality`, `--markdown`,
   `--json`, `GITHUB_STEP_SUMMARY`, `GITHUB_OUTPUT`, plus `result.json` and
   `findings.json` in the scratch dir.

Exit codes: `0` ok · `1` gate failed, analysis failed with `--fail-on` set, or
no thread could be posted on a platform adapter · `2` usage/configuration error.

## Security model

- The analyzer is deny-by-default and read-only; the diff and the repository are
  treated as untrusted data.
- The model process never sees CI tokens: the child env is an allow-list.
- Consumer repo config (`opencode.json`, `AGENTS.md`) is not loaded.
- Model text is sanitized before posting; markers cannot be forged.
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
