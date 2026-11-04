# Setup

How to enable the review agent on a consumer repository. The agent is consumed
as a composite GitHub Action (`uses: anglesen1120/code-review-agent@v1`), as a
CLI (`bin/cra.js`), or as the Docker image — see
[`CI-INTEGRATIONS.md`](CI-INTEGRATIONS.md) for GitLab, Jenkins, Bitbucket and
Azure.

## Prerequisites

- A repository on GitHub (public or private).
- A **provider API key** for the LLM endpoint. The default is **OpenCode Go**
  (`go/deepseek-v4.1-flash` at `https://opencode.ai/zen/go/v1`); the key is the
  `provider.go.options.apiKey` value from your local opencode config. Any
  OpenAI-compatible endpoint works if you override `base-url` and `model`.
- Optional: a **classic Personal Access Token** — only needed if you want the
  agent to auto-resolve its own review threads (see below).

## 1. Create a classic PAT (only for auto-resolve)

GitHub only lets **real user accounts** resolve review conversations via the
API. The built-in `GITHUB_TOKEN` (`github-actions` app) and fine-grained PATs
can *post* threads but **cannot resolve them** — both return an HTTP 403
(`Resource not accessible by integration` / `... by personal access token`) on
`resolveReviewThread`. The only credential that can auto-resolve is a classic
PAT, which acts as its owner.

1. github.com → **Settings** → **Developer settings** → **Personal access
   tokens** → **Tokens (classic)**.
2. **Generate new token (classic)**.
3. Tick the **`repo`** scope.
4. Generate and copy the token.
5. On the consumer repo: **Settings → Secrets and variables → Actions → New
   repository secret**, name it e.g. `CODE_REVIEW_TOKEN`, paste the token.

### Token capability matrix

| Credential | Post threads | Post summary | Resolve threads |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` (default) | ✅ | ✅ | ❌ |
| Fine-grained PAT (Contents read, Pull requests/Issues write) | ✅ | ✅ | ❌ |
| **Classic PAT (`repo` scope)** | ✅ | ✅ | ✅ |

When you use a classic PAT, the review threads are **authored by you** and
GitHub displays resolved conversations as resolved by you. That is expected: it
is the only token type GitHub permits to resolve. The decision to resolve is
still made by the agent, not by a human clicking "Resolve conversation".

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
concurrency:
  group: code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
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
          fail-on: critical
```

- `github-token` — leave it unset (and remove `bot-login`) if you are happy for
  the bot to post threads but **never auto-resolve them**. With the classic PAT
  set, the agent auto-resolves threads whose issue it detects as fixed.
- `bot-login` — the username of the classic PAT. The default `github-actions`
  is correct when you use `GITHUB_TOKEN` only.
- `base-url` / `model` — optional, override the provider endpoint/model.
- `fail-on` — `none` (default), `critical` or `warning`. With anything but
  `none`, a failed analysis also fails the job (fail closed).
- `max-diff-bytes` — diff budget; default `250000`.
- `sarif-file` — write a SARIF 2.1.0 report, e.g. for
  `github/codeql-action/upload-sarif`.
- `set-status` — also set the `code-review-agent` commit status; add
  `statuses: write` to `permissions` when you enable it.

## 4. Enable branch protection (the merge gate)

On the consumer repo: **Settings → Branches → Add rule** for the default
branch:

- **Require a pull request before merging** (recommended).
- **Require conversation resolution before merging** — this is the gate. While
  any review thread is unresolved, the merge button stays blocked.
- Optional: if you set `set-status: true`, also add the `code-review-agent`
  status check as a required check.

### How the gate behaves

- Agent posts threads → merge **blocked**.
- Dev pushes a fix → workflow re-runs → the agent re-reviews and resolves
  threads whose issue is gone **and** whose file changed since the last
  reviewed commit (or that the platform marks outdated) → merge unblocks
  progressively.
- If a dev replies and resolves a thread manually, the agent **never reopens or
  re-posts** it.
- A failed analysis posts and resolves **nothing**: the previous threads keep
  blocking merge.
- Findings that cannot be anchored inside a diff hunk appear in the summary
  only; Critical/Warning ones still fail `--fail-on`.

The precise rules are in [`THREAD-LIFECYCLE.md`](THREAD-LIFECYCLE.md).

The review is **advisory**: an injected PR can make the model report nothing, so
keep human review and deterministic scanners as the real gate. Two delivery
details matter operationally: with `set-status`, a failed status API call exits
`1` after the reports are written; and files skipped by `max-diff-bytes` keep
their threads open (a fully over-budget diff is reported as not reviewed and
exits `1` regardless of `fail-on`).

## Inputs reference

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | — | Provider API key for the analyzer. |
| `github-token` | no | `github.token` | Token used to post/resolve. A classic PAT (`repo` scope) is required for auto-resolve. |
| `base-url` | no | `https://opencode.ai/zen/go/v1` | Provider endpoint (OpenAI-compatible). |
| `model` | no | `go/deepseek-v4.1-flash` | `provider/model` for the analyzer. |
| `diff-scope` | no | `""` | Extra comma-separated pathspecs to exclude from review. |
| `set-status` | no | `false` | Set the `code-review-agent` commit status; needs `statuses: write`. |
| `bot-login` | no | `github-actions` | Login that authors and resolves the threads. |
| `fail-on` | no | `none` | `none` \| `critical` \| `warning`; fails the step (and fails closed on analysis errors). |
| `max-diff-bytes` | no | `250000` | Diff budget sent to the model; whole files beyond it are skipped and listed. |
| `sarif-file` | no | `""` | Path for a SARIF 2.1.0 report. |
| `opencode-version` | no | `1.18.18` | `opencode-ai` npm version the action installs. |

## Outputs

| Output | Description |
| --- | --- |
| `findings-count` | Total findings (all severities) for this run. |
| `unresolved-count` | Open Critical/Warning threads remaining after this run. |
| `review-id` | GitHub review id created this run, if any. |
| `analysis-failed` | `true` when the analyzer could not produce valid findings. |
