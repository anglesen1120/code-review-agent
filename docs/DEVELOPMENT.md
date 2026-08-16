# Development

How to work on `code-review-agent` locally: run the tests, do a dry-run review
without GitHub, and drive a local fix-review cycle. Everything here is offline
except the analyzer itself, which needs the provider API key.

## Requirements

- Node.js ≥ 20 (the poster and tests are zero-dependency).
- Bash (the analyzer scripts).
- `opencode` CLI (installed automatically by the action; for local dry-runs
  install it yourself: `npm install -g opencode-ai@1.18.18`).
- A provider API key for local analyzer runs (e.g. `DEEPSEEK_API_KEY`).

## Tests

```bash
npm test
```

Runs `node --test` over `tests/`. The suites cover:

- **Schema** (`tests/schema.test.js`) — `validate.js` against the fixtures and
  the canonical `schema/findings.schema.json`.
- **Poster** (`tests/poster.test.js`) — the pure `computeDelta` helpers:
  key normalization, dedupe, never-reopen, conservative resolve, title
  similarity, markdown rendering. No network, no LLM.

To add a test, drop a fixture in `tests/fixtures/` and extend the suites. Keep
the poster's logic in exported pure functions so it stays testable.

## Local dry-run (analyzer only, no GitHub)

From any repo that has the agent checked out, review the working-tree changes:

```bash
MODE=local ACTION_PATH=/path/to/code-review-agent DEEPSEEK_API_KEY=<your key> \
  bash /path/to/code-review-agent/scripts/analyze.sh
```

Findings land in `.review/findings.json` (gitignored). A `.review/error` marker
means analysis failed or produced invalid output. Only **added/modified lines**
may be referenced — the reviewer prompt enforces this and the poster would
otherwise drop the anchor.

To review the diff of a feature branch against the default branch instead of
the working tree, write the diff first:

```bash
mkdir -p .review
git fetch origin 2>/dev/null || true
git diff --no-color -U5 origin/main...HEAD -- . > .review/pr.diff
MODE=local ACTION_PATH=/path/to/code-review-agent DEEPSEEK_API_KEY=<your key> \
  bash /path/to/code-review-agent/scripts/analyze.sh
```

## Local skill (interactive fix-review cycle)

The bundled Claude Code skill (`skills/code-review/SKILL.md`) runs the same
analyzer but presents results interactively and supports a fix-review loop:

1. Compute the diff (feature branch vs default, or working tree).
2. Run the analyzer.
3. Present findings grouped by severity.
4. On request, apply fixes one at a time (with approval) and re-run until a
   finding disappears.

Invoke it with `review my code`, or read the skill file for the exact flow.

## Layout cheat-sheet

| File | Responsibility |
| --- | --- |
| `action.yml` | Composite action: install opencode, prepare diff, fetch threads, analyze, apply. |
| `scripts/make-config.js` | Builds `opencode.json` (provider + read-only agent + prompt). |
| `scripts/analyze.sh` | Runs `opencode run --format json`, retries/degrades. |
| `scripts/parse-events.js` | Extracts findings JSON from the opencode event stream. |
| `scripts/validate.js` | Schema validation — single enforcement point. |
| `scripts/post-review.js` | Poster: `fetch` (read threads) and `apply` (delta → post/resolve/summary). |
| `schema/findings.schema.json` | Canonical findings schema (source of truth). |
| `prompts/reviewer-system.md` | Reviewer rubric for the opencode agent. |

## Changing the provider/model

Defaults live in `scripts/analyze.sh` and `scripts/make-config.js`
(`go/deepseek-v4-flash` / `https://opencode.ai/zen/go/v1`). Consumers override
them via the `model` and `base-url` inputs. Any OpenAI-compatible endpoint
works; keep the model name in sync with what your provider exposes.

## Verifying a change end-to-end

The E2E harness is a separate public repo (`anglesen1120/cra-e2e`) with planted
bugs. See [`docs/E2E-RESULTS.md`](E2E-RESULTS.md) for the scenario and the
assertions to re-run after a change to the action.
