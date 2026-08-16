# Code Review Agent

A self-contained, CodeRabbit-style code review agent that runs on every pull
request in GitHub Actions: it reviews the diff, posts **inline review threads**
(Critical / Warning) plus a **summary comment**, and manages thread resolution
so unresolved threads block merge.

No external review SaaS. The review is performed by an **opencode** agent
(read-only, provider-agnostic) and the thread lifecycle is handled by a small
deterministic Node script. You bring your own provider API key (OpenCode Go by
default, but any OpenAI-compatible endpoint works — set `base-url` and `model`).

## How it works

Two stages:

```
push → checkout → [Analyzer] opencode run (read-only) → findings.json
                      ↓
              [Poster] deterministic Node script
                      ↓
        post new inline threads · resolve fixed threads
        update one summary comment · (optional) commit status
```

- **Analyzer** — runs `opencode run --format json` with a dedicated
  `code-reviewer` agent (read-only: `edit`/`write`/`bash` denied). It reads the
  PR diff and produces a structured `findings.json` (schema below). No LLM call
  happens when the diff is empty or only matches ignore patterns.
- **Poster** — never calls an LLM and never executes comment/thread text. It
  diffs the new findings against the bot's existing review threads (GitHub
  GraphQL), posts only genuinely new issues, auto-resolves threads whose issue
  is fixed, updates a single summary comment, and optionally sets a commit
  status.

### Merge gating (thread resolution)

GitHub's **Require conversation resolution before merging** branch-protection
rule is the gate. Unresolved review threads block merge. When a dev pushes
fixes, the workflow re-runs; the agent re-reviews and **resolves** threads whose
issue is gone. If a dev replies and resolves a thread manually, the agent
**never reopens or re-posts it**.

## Quick start (consumer repo)

1. **Create a Personal Access Token** for auto-resolve — see *Why a PAT?*
   below. This must be a **classic** token with the `repo` scope. Only a
   classic PAT (which acts as a real user) can *resolve* review threads via
   the API; a fine-grained PAT can post threads and comments but
   `resolveReviewThread` returns `Resource not accessible by personal access
   token` (HTTP 403) even with Pull requests: Write. Add it as a secret, e.g.
   `CODE_REVIEW_TOKEN` (Settings → Secrets and variables → Actions).
2. Add a secret for your provider key, e.g. `DEEPSEEK_API_KEY` (Settings →
   Secrets and variables → Actions). For the default OpenCode Go provider this
   is the key from your opencode config (`provider.go.options.apiKey`).
3. Add the workflow (copy `example/.github/workflows/code-review.yml`):

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
         - uses: anglesen1120/code-review-agent@v1
           with:
             api-key: ${{ secrets.DEEPSEEK_API_KEY }}
             github-token: ${{ secrets.CODE_REVIEW_TOKEN }}
             bot-login: <your-github-username>
   ```

   Leave `github-token` unset (and remove `bot-login`) if you are happy for the
   bot to post threads but **never auto-resolve them** — in that case reviewers
   resolve conversations manually.

4. Enable branch protection on your default branch (Settings → Branches):
   - **Require a pull request before merging** (recommended).
   - **Require conversation resolution before merging** — this is the gate that
     blocks merge while review threads are unresolved.
   - Optional: if you set `set-status: true`, also add the `code-review-agent`
     status check as required.

### Why a PAT?

GitHub's built-in `GITHUB_TOKEN` (the `github-actions` app) can **post** review
threads but **cannot resolve them** — the `resolveReviewThread` mutation returns
`Resource not accessible by integration` even with `pull-requests: write`.

The same applies to **fine-grained PATs**: they can post threads and comments,
but `resolveReviewThread` returns `Resource not accessible by personal access
token` (HTTP 403) even with **Pull requests: Read and write**. Auto-resolving
threads that the agent previously flagged therefore requires a **classic PAT
with the `repo` scope** — the only token type that carries a real user's write
rights for this mutation.

With a PAT the review threads are authored by **you** (your username), so set
`bot-login` to your username. Without a PAT the threads are authored by
`github-actions`; they still block merge, and the agent still avoids re-posting,
but nobody (agent included) can auto-resolve them from CI.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | — | Provider API key for the opencode analyzer (e.g. `DEEPSEEK_API_KEY` secret). |
| `github-token` | no | `github.token` | Token with `pull-requests: write` and `contents: read`. |
| `base-url` | no | `https://opencode.ai/zen/go/v1` | Provider endpoint (OpenAI-compatible). |
| `model` | no | `go/deepseek-v4-flash` | `provider/model` for the analyzer. Adjust to the exact model your provider exposes. |
| `diff-scope` | no | `""` | Extra comma-separated gitignore-style patterns to exclude from review. |
| `set-status` | no | `false` | Set a commit status: `failure` while unresolved Critical/Warning threads remain, else `success`. |

## Outputs

| Output | Description |
| --- | --- |
| `findings-count` | Total findings (all severities) for this run. |
| `unresolved-count` | Open Critical/Warning threads remaining after this run. |
| `review-id` | GitHub review id created this run, if any. |

## Findings schema

`schema/findings.schema.json` is the single source of truth. Each finding has
`severity` (`Critical` | `Warning` | `Info`), `category`, `file`, `line`
(new-file line, must be an added/modified diff line), `title`, `description`,
`suggestion`, and optional `startLine`/`endLine`.

- **Critical** — security, data loss, crashes, broken core flows.
- **Warning** — bugs, races, performance, anti-patterns, missing validation.
- **Info** — style/minor; **never** posted as a thread, only in the summary.

The analyzer caps output at 20 findings (severity-first). The reviewer prompt
(`prompts/reviewer-system.md`) encodes the rubric, the untrusted-input rule, and
a .NET/Clean Architecture checklist for .NET repos.

## Local usage

From any repo with the agent checked out, review the current working-tree
changes:

```bash
MODE=local ACTION_PATH=/path/to/code-review-agent DEEPSEEK_API_KEY=... \
  bash /path/to/code-review-agent/scripts/analyze.sh
# findings at .review/findings.json
```

Or install the bundled Claude Code skill (`skills/code-review/SKILL.md`) and run
`review my code` — it computes the diff, runs the same opencode engine, and
supports a fix-review cycle with approval.

## Development

- `npm test` — runs `node --test` over `tests/` (schema + poster delta
  algorithm; no network, no LLM).
- Local dry-run — run `analyze.sh` as above and inspect `findings.json` (only
  added/modified lines should be referenced).
- E2E — a throwaway GitHub repo with a planted bug; see "Merge gating" scenario
  above.

## Risks & limitations

- The `GITHUB_TOKEN` can only resolve threads authored by the bot, so only
  bot-authored threads are ever auto-resolved. Dev-authored threads are never
  touched.
- To stay deterministic, the poster resolves a thread only when the finding is
  gone **and** the code clearly changed (thread outdated, or its file in the
  diff). If the code is untouched, an open thread is left for a human.
- Repository config (`opencode.json`, `AGENTS.md`) is ignored during analysis
  (`OPENCODE_DISABLE_PROJECT_CONFIG=1`) and its contents are treated as
  untrusted data, so a consumer repo cannot inject instructions into the
  reviewer.
- Cost: one analyzer call per push that touches code. Empty/ignored diffs skip
  the LLM entirely. `model` and `diff-scope` let you control cost further.

## License

MIT
