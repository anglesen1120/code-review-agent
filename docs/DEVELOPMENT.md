# Development

How to work on `code-review-agent` locally: run the tests, review a diff without
touching a platform, and drive the interactive fix-review cycle. Everything here
is offline except the analyzer, which needs a provider API key.

## Requirements

- Node.js ≥ 20 (zero runtime npm dependencies).
- `opencode` CLI: `npm install -g opencode-ai@1.18.18` (the Docker image and
  the GitHub Action install this version).
- A provider API key for analyzer runs (`CRA_API_KEY`, or the legacy fallback
  `DEEPSEEK_API_KEY`).
- Optional: Docker, to build the shipped image.

## Tests

```bash
npm test
```

Runs `node --test` over `tests/`. The suites are offline (no network, no LLM)
and cover:

- **Schema** (`tests/schema.test.js`) — `src/validate.js` against the fixtures
  and the canonical `schema/findings.schema.json`.
- **Diff** (`tests/diff.test.js`) — `splitDiffByFile`, `parseUnifiedDiff`
  anchors (add/context lines, renames, quoted paths), `capDiff` boundaries,
  exclusion pathspecs.
- **Lifecycle** (`tests/lifecycle.test.js`) — `computeDelta`: key
  normalization, dedupe, never-reopen, conservative resolve, title similarity,
  markdown rendering and `gateFails` severity semantics.
- **Analyzer** (`tests/analyzer.test.js`) — `buildOpencodeConfig` (permission
  denials, external directory scope), event-stream extraction, `childEnv`
  allow-list.
- **Adapters** (`tests/github.test.js`, `tests/gitlab.test.js`) — pagination,
  retries/`Retry-After`, error redaction, thread discovery, summary upsert,
  `computeDelta` inputs. `fetch` is injected (`fetchImpl`), never called for
  real.
- **Reporters** (`tests/reporters.test.js`) — SARIF shape and fingerprints,
  Code Quality fields, Markdown report.

To add a test, drop a fixture in `tests/fixtures/` and extend the suites. Keep
logic in exported pure functions so it stays testable.

## Local run (no platform)

`cra analyze` reviews the working tree; with `--base` it reviews the branch
against that base. No threads, no PR comments — report files and exit code only.

```bash
cd /path/to/consumer-repo
CRA_API_KEY=<key> node /path/to/code-review-agent/bin/cra.js analyze
# .review/findings.json  +  markdown report on stdout
```

```bash
CRA_API_KEY=<key> node /path/to/code-review-agent/bin/cra.js analyze \
  --base origin/main \
  --sarif .review/cra.sarif \
  --markdown .review/cra.md
```

Useful flags while developing:

- `--dry-run` — with a platform, compute and print the post/keep/resolve plan
  without writing anything.
- `--out-dir DIR` — scratch dir (default `.review` for `analyze`, a temp dir
  otherwise). It holds `pr.diff`, `findings.json`, `existing_threads.json`,
  `result.json`, `opencode.json`, `events.jsonl` and `opencode.err`.
- `--max-diff-bytes N` / `--exclude 'glob,glob'` — diff budget and extra
  exclusions.
- `--model`, `--base-url` — point at another OpenAI-compatible endpoint.
- `--fail-on critical|warning` — exercise the gate locally; remember that a
  failed analysis exits 1 only when this is not `none`.

Only **added/modified lines inside diff hunks** can be anchored as inline
threads; everything else goes to the summary. If a finding you expect is
missing from `findings.json`, check the "Dropped:" notes (over-cap findings) and
the analyzer stderr/events tails that are printed after the second failed
attempt.

Environment: `CRA_OPENCODE_BIN` overrides the opencode executable,
`CRA_ANALYZE_TIMEOUT_MS` the per-attempt timeout (default 15 min). Full
variable reference: [`CI-INTEGRATIONS.md`](CI-INTEGRATIONS.md#environment-variables).

## Local skill (interactive fix-review cycle)

The bundled agent skill (`skills/code-review/SKILL.md`) runs the same analyzer
through `bin/cra.js analyze` and presents the results interactively:

1. Compute the diff (feature branch vs default, or working tree).
2. Run `node "$AGENT_ROOT/bin/cra.js" analyze`.
3. Present findings grouped by severity.
4. On request, apply fixes one at a time (with approval) and re-run until a
   finding disappears.

Invoke it with `review my code`, or read the skill file for the exact flow.

## Layout cheat-sheet

| File | Responsibility |
| --- | --- |
| `bin/cra.js` | CLI: argument/env resolution, diff, fetch, analyze, lifecycle, reports, exit codes. |
| `src/analyzer.js` | opencode config (read-only agent), child env allow-list, run + retry, findings extraction. |
| `src/diff.js` | `gitDiff`, exclusions, `capDiff`, `parseUnifiedDiff`, `changedFilesBetween`. |
| `src/lifecycle.js` | `computeDelta`, `matchThread`, `gateFails`, markers, `sanitize`, markdown. |
| `src/reporters.js` | SARIF, GitLab Code Quality, Markdown report. |
| `src/platforms/index.js` | Platform detection, adapter factory, `inferBaseRef` for CIs without an adapter. |
| `src/platforms/github.js` | GitHub REST + GraphQL adapter. |
| `src/platforms/gitlab.js` | GitLab REST adapter. |
| `src/validate.js` | Schema validation and normalization — single enforcement point. |
| `schema/findings.schema.json` | Canonical findings schema (source of truth). |
| `prompts/reviewer-system.md` | Reviewer rubric for the opencode agent. |
| `Dockerfile` | CLI image used by the non-GitHub CI templates. |
| `ci/` | GitLab, Jenkins, Bitbucket and Azure templates. |

## Changing the provider/model

Defaults live in `src/analyzer.js` (`DEFAULT_MODEL = "go/deepseek-v4.1-flash"`,
`DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1"`). Consumers override them
with `--model`/`--base-url` or `CRA_MODEL`/`CRA_BASE_URL`. Any
OpenAI-compatible endpoint works; keep the model name in sync with what the
provider exposes.

## Adding a platform adapter

Implement the contract in `src/platforms/<name>.js`:
`create<Name>Platform({env, fetchImpl, log})` returning
`{name, prLabel, context, fetchState, postThreads, resolveThread, upsertSummary,
setStatus, fileUrl}`, plus `detect<Name>(env)`; then register it in
`src/platforms/index.js` (`PLATFORMS`, `detectPlatform`, `createPlatform`).
Adapters must paginate, retry `429`/`5xx`/network errors with backoff, honour
`Retry-After`, fail fast on other `4xx`, and never log or embed tokens. Test it
with an injected `fetchImpl`; no network in tests.

## Verifying a change end-to-end

The E2E harness is a separate public repo (`anglesen1120/cra-e2e`) with planted
bugs. See [`docs/E2E-RESULTS.md`](E2E-RESULTS.md) for the scenario and the
assertions to re-run after a change to the action or the CLI.
