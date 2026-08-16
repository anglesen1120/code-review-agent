# Setup

How to enable the review agent on a consumer repository. The agent is consumed
as a composite GitHub Action: `uses: anglesen1120/code-review-agent@v1`.

## Prerequisites

- A repository on GitHub (public or private).
- A **provider API key** for the LLM endpoint. The default is **OpenCode Go**
  (`go/deepseek-v4-flash` at `https://opencode.ai/zen/go/v1`); the key is the
  `provider.go.options.apiKey` value from your local opencode config. Any
  OpenAI-compatible endpoint works if you override `base-url` and `model`.
- A **classic Personal Access Token** (see next section — this is required for
  auto-resolve).

## 1. Create a classic PAT (required)

GitHub only lets **real user accounts** resolve review conversations via the
API. The built-in `GITHUB_TOKEN` (`github-actions` app) and fine-grained PATs
can *post* threads but **cannot resolve them** — both return an HTTP 403
(`Resource not accessible by integration` / `... by personal access token`) on
`resolveReviewThread`. The only credential that can auto-resolve is a classic
PAT, which acts as its owner.

1. github.com → **Settings** → **Developer settings** → **Personal access
   tokens** → **Tokens (classic)**.
2. **Generate new token (classic)**.
3. Tick the **`repo`** scope (full control of private repositories — this
   covers every endpoint the agent uses).
4. Generate and copy the token.
5. On the consumer repo: **Settings → Secrets and variables → Actions → New
   repository secret**, name it e.g. `CODE_REVIEW_TOKEN`, paste the token.

### Token capability matrix

| Credential | Post threads | Post summary | Resolve threads |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` (default) | ✅ | ✅ | ❌ |
| Fine-grained PAT (Pull requests/Issues: write) | ✅ | ✅ | ❌ |
| **Classic PAT (`repo` scope)** | ✅ | ✅ | ✅ |

When you use a classic PAT, the review threads are **authored by you** (your
username) and GitHub displays resolved conversations as resolved by you. That
is expected: it is the only token type GitHub permits to resolve. The decision
to resolve is still made automatically by the agent, not by a human clicking
"Resolve conversation".

## 2. Add the provider key secret

Add your provider API key as another secret, e.g. `DEEPSEEK_API_KEY`
(**Settings → Secrets and variables → Actions**). For the default OpenCode Go
provider this is the key from your local opencode config
(`provider.go.options.apiKey`).

## 3. Add the workflow

Copy `example/.github/workflows/code-review.yml` into the consumer repo. It
looks like this:

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

- `github-token` — leave it unset (and remove `bot-login`) if you are happy for
  the bot to post threads but **never auto-resolve them** (reviewers then
  resolve conversations manually). With the classic PAT set, the agent
  auto-resolves threads whose issue it detects as fixed.
- `bot-login` — the username of the classic PAT. The poster uses it to identify
  the bot's own threads. Default `github-actions` is correct when you are using
  `GITHUB_TOKEN` only.
- `base-url` / `model` — optional, override the provider endpoint/model.

## 4. Enable branch protection (the merge gate)

On the consumer repo: **Settings → Branches → Add rule** for the default
branch:

- **Require a pull request before merging** (recommended).
- **Require conversation resolution before merging** — this is the gate.
  While any review thread is unresolved, the merge button stays blocked.
- Optional: if you set `set-status: true` in the workflow, also add the
  `code-review-agent` status check as a required check.

### How the gate behaves

- Agent posts threads → merge **blocked**.
- Dev pushes a fix → workflow re-runs on `synchronize` → the agent re-reviews
  and **auto-resolves** threads whose issue is gone → merge unblocks
  progressively.
- If a dev replies and resolves a thread manually, the agent **never reopens or
  re-posts** it.

## Inputs reference

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | — | Provider API key for the opencode analyzer. |
| `github-token` | no | `github.token` | Token with `pull-requests: write`. A classic PAT (`repo` scope) is required for auto-resolve. |
| `base-url` | no | `https://opencode.ai/zen/go/v1` | Provider endpoint (OpenAI-compatible). |
| `model` | no | `go/deepseek-v4-flash` | `provider/model` for the analyzer. |
| `diff-scope` | no | `""` | Extra comma-separated gitignore-style patterns to exclude from review. |
| `set-status` | no | `false` | Set a commit status: `failure` while unresolved Critical/Warning threads remain, else `success`. |

## Outputs

| Output | Description |
| --- | --- |
| `findings-count` | Total findings (all severities) for this run. |
| `unresolved-count` | Open Critical/Warning threads remaining after this run. |
| `review-id` | GitHub review node id created this run, if any. |
