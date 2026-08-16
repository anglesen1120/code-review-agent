# Architecture

This document describes how the agent is built and why it is split the way it
is. It is aimed at maintainers and anyone who wants to extend the tool.

## Overview

The agent is a **self-contained GitHub Action** (`action.yml`) with **no
external review SaaS**. It is built from two stages that run back to back on
every pull-request event:

```
push → checkout → [prepare: fetch + compute diff]
                      ↓
       [fetch] existing bot threads (GraphQL)
                      ↓
       [Analyzer] opencode run --format json  →  findings.json
                      ↓
       [Poster] deterministic Node script     →  post · resolve · summary
```

| Stage | Component | What it does | Deterministic? |
| --- | --- | --- | --- |
| Prepare | `action.yml` (bash) | Fetches base/head SHAs, writes the unified diff and changed-files list into a scratch dir. | yes |
| Fetch | `scripts/post-review.js fetch` | Reads the bot's existing review threads via GraphQL. | yes |
| Analyzer | `scripts/analyze.sh` → `opencode run` | Turns the diff into a schema-valid `findings.json`. The only stage that calls an LLM. | no |
| Poster | `scripts/post-review.js apply` | Posts new threads, resolves fixed ones, updates one summary comment, optional status. | yes |

Splitting the LLM stage from the lifecycle stage is deliberate:

- **The thread lifecycle is deterministic.** Posting, deduplicating, resolving
  and summarizing must be repeatable and unit-testable without burning tokens.
- **Cost is bounded.** The LLM runs exactly once per push that touches code.
  Empty or fully-ignored diffs skip the LLM entirely.
- **Safety.** The poster never executes text produced by the LLM or by repo
  files — it only compares normalized string keys. This is the prompt-injection
  boundary.

## Repository layout

```
code-review-agent/
├── action.yml                    # composite action contract (inputs/steps)
├── schema/findings.schema.json   # canonical findings schema
├── prompts/reviewer-system.md    # reviewer rubric for the opencode agent
├── scripts/
│   ├── analyze.sh                # orchestrates the opencode run
│   ├── make-config.js            # builds opencode.json (provider + agent)
│   ├── parse-events.js           # extracts JSON from `opencode run --format json`
│   ├── validate.js               # schema validation (shared by analyzer + poster + tests)
│   └── post-review.js            # poster: `fetch` and `apply` subcommands
├── tests/                        # node:test suites (no network, no LLM)
├── skills/code-review/SKILL.md   # local Claude Code skill (same engine, interactive)
└── example/.github/workflows/code-review.yml  # drop-in consumer workflow
```

## Prepare step (deterministic, in `action.yml`)

1. `git fetch --no-tags origin <base> <head>`.
2. Write `${{ runner.temp }}/cra/env` with `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`,
   `MODEL`, `BASE_URL`.
3. Compute `git diff --no-color -U5 <base>...<head>` into `$SCRATCH/pr.diff`,
   excluding lockfiles, generated bundles and user-supplied `diff-scope`
   patterns.
4. Write `$SCRATCH/changed_files.json` (repo-relative list) — used later by the
   conservative resolve rule.
5. Emit `diff_bytes` so a later step can skip analysis for empty diffs.

The scratch dir lives under the runner temp (`${{ runner.temp }}/cra`), **outside
the checkout**, so a consumer repo cannot tamper with it.

## Fetch step (poster)

`post-review.js fetch` runs a GraphQL `reviewThreads` query against the PR and
keeps only threads whose root comment was authored by the bot login
(`bot-login` input, default `github-actions`). It writes
`$SCRATCH/existing_threads.json` with the thread `id`, `key`, `path`, `line`,
`isResolved`, `isOutdated`. This file is read by the analyzer (for continuity)
and by the poster on the next `apply`.

## Analyzer (opencode, read-only)

`analyze.sh`:

1. Generates an `opencode.json` via `make-config.js`:

   - A provider block for an **OpenAI-compatible** endpoint. Defaults: OpenCode
     Go (`https://opencode.ai/zen/go/v1`) with model `go/deepseek-v4-flash`.
     Both are action inputs (`base-url`, `model`), so any OpenAI-compatible
     provider works.
   - A `code-reviewer` agent with **read-only permissions**:
     `edit: deny`, `write: deny`, `bash: deny`, `webfetch: allow`,
     `read: allow`, `external_directory: allow`.
     The `external_directory: allow` is required so the agent can read the
     diff and `existing_threads.json` from the runner-temp scratch dir; it
     still cannot write, edit, or execute anything.
   - The agent `prompt` is the content of `prompts/reviewer-system.md`.

2. Sets `OPENCODE_CONFIG` to the generated file and
   `OPENCODE_DISABLE_PROJECT_CONFIG=1` so the consumer repo's own
   `opencode.json` / `AGENTS.md` can never influence the reviewer
   (**anti-injection**).

3. Runs:

   ```bash
   opencode run --agent code-reviewer --format json --model "$MODEL" "<prompt>"
   ```

4. `parse-events.js` concatenates the `text` events, strips markdown fences,
   extracts the outermost JSON object, and validates it with `validate.js`
   against `schema/findings.schema.json`.

5. **Retry / degrade.** If the first run does not produce valid findings, the
   analyzer retries once with a stricter "output ONLY JSON" instruction. If
   that also fails it writes a degraded empty `findings.json` plus an `error`
   marker and exits `0` — the poster still updates the summary, and the PR
   review is never hard-failed.

If the diff is empty or only matches ignore patterns, analysis is skipped and
an empty `findings.json` is written with no LLM call.

## Poster (`post-review.js apply`)

The poster is a zero-dependency Node script. Its `apply` subcommand:

1. Loads `findings.json`, `existing_threads.json`, `changed_files.json`.
2. Computes the **delta** between what is desired and what already exists
   (see [`docs/THREAD-LIFECYCLE.md`](THREAD-LIFECYCLE.md) for the algorithm).
3. Posts genuinely new Critical/Warning findings as one PR review (REST),
   falling back to per-comment posting when the batch fails.
4. Resolves threads whose issue is gone (GraphQL `resolveReviewThread`),
   conservatively and never touching dev-resolved threads.
5. Upserts one summary comment (idempotent via a marker).
6. Optionally sets a commit status.

The poster never calls the LLM and never executes text from any comment or
file — it only matches normalized keys. A failed summary comment is logged but
does not fail the run; a run where **no** thread could be posted fails loudly
so a misconfigured token is visible.

## Security model

- The analyzer is **read-only** (all write/execute tools denied).
- Consumer repo config (`opencode.json`, `AGENTS.md`, PR text, comments) is
  treated as **untrusted data**; the system prompt instructs the model to
  ignore any instructions found in it, and `OPENCODE_DISABLE_PROJECT_CONFIG=1`
  blocks repo config from being loaded at all.
- The poster never interprets comment text as instructions — only as string
  keys for matching.
- The API key is passed via a GitHub secret and referenced by name in the
  generated opencode config (`{env:DEEPSEEK_API_KEY}`); it is never written
  into the repo or logs.

## Cost

- One LLM call per push that touches code (plus one retry when the first
  output is invalid).
- Empty / fully-ignored diffs skip the LLM.
- The model is capped at 20 findings and is severity-first.
- `model` and `diff-scope` are inputs, so cost can be tuned per consumer.

## Non-goals / boundaries

- The agent does not check out, build, or run the consumer's code — it reviews
  the diff and reads files for context only.
- The poster only manages threads it (or the configured bot login) authored;
  human threads are never touched.
- Everything that touches the LLM is replaceable via the `base-url` / `model`
  inputs as long as the endpoint is OpenAI-compatible.
