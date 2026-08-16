# Troubleshooting

Common problems and how to diagnose them. When in doubt, open the workflow run
log and search for `post-review:` and `##[error]` lines.

## "Unable to resolve action `anglesen1120/code-review-agent`"

The action repository must be **public** for `uses: anglesen1120/code-review-agent@v1`
to work from any repo. A private action repo can only be used from repos in the
same owner/org on a paid plan. Make `code-review-agent` public, or publish the
action elsewhere.

## `Resource not accessible by integration` (HTTP 403) on resolve

The built-in `GITHUB_TOKEN` (the `github-actions` app) can post threads but
**cannot resolve them**. This is a GitHub platform restriction. To enable
auto-resolve, supply a **classic PAT with the `repo` scope** via `github-token`
and set `bot-login` to that account's username. See
[`docs/SETUP.md`](SETUP.md).

## `Resource not accessible by personal access token` (HTTP 403)

This is the fine-grained PAT equivalent of the same restriction. Even with
Pull requests: write (and Issues: write for the summary comment), a
fine-grained PAT **cannot** call `resolveReviewThread`. It *can* post threads
and comments. Use a **classic PAT (`repo` scope)** for auto-resolve.

If you are not trying to auto-resolve and still see this on every write:

- The fine-grained token may not have **repository access** to the repo — under
  *Repository access* pick the repo (or *All repositories*).
- Permissions may be set to **Read-only** — set Contents: Read-only, Pull
  requests: Read and write, and (for the summary comment) Issues: Read and
  write.

## Threads are posted but merge is still green / not blocked

Merge gating depends on branch protection, not on the action. On the default
branch enable **Require a pull request before merging** and **Require
conversation resolution before merging** (Settings → Branches → Add rule).
Branch protection can silently disappear if the repo visibility changes or the
rule was never actually saved — re-check `Settings → Branches`.

Note: GitHub's own **Copilot Code Review** also creates threads that block
merge. If you don't use it, disable it in repo settings; it is separate from
this agent.

## `post-review: could not post any review thread — the token cannot write...`

The token could not deliver any inline thread. Check that `github-token` has
`pull-requests: write` (and repository access if it is a fine-grained token).
The run intentionally fails so the misconfiguration is visible rather than
silently posting nothing.

## Analysis produced invalid findings / `analysis_error=1`

The analyzer retries once, then degrades to an empty `findings.json` so the
poster can still update the summary. Common causes:

- **Wrong model or endpoint.** The default is OpenCode Go
  (`go/deepseek-v4-flash` at `https://opencode.ai/zen/go/v1`). The model
  `deepseek-v4-flash` does **not** exist on `api.deepseek.com`. Set `base-url`
  and `model` to match your provider.
- **Agent cannot read the scratch dir.** The read-only agent needs
  `read: allow` and `external_directory: allow` in its generated opencode
  config (set in `scripts/make-config.js`). If you forked/modified the action,
  verify those are present.
- **API key missing.** `api-key` is required; if the key env is empty the
  analyzer writes a "skipped" findings file (see the log for
  `Analysis skipped: API key not configured`).
- **Provider outage / timeouts.** Check the `opencode.err` tail in the log.

Inspect the log for the model's stderr (`--- opencode stderr (tail) ---`) and
the raw events (`--- opencode events (tail) ---`).

## No threads at all, but the summary exists

Info findings are never posted as threads — only Critical and Warning. If the
reviewer genuinely found nothing critical/warning, only the summary appears.
Also confirm the findings anchor to **added/modified lines**: GitHub rejects
comments on unchanged lines, and the poster degrades those to summary-only.

## `post-review: found 0 bot thread(s) as <login>`

The poster could not find its own previous threads. Check `bot-login`:

- With `GITHUB_TOKEN`, threads are authored by `github-actions` — keep the
  default.
- With a classic PAT, threads are authored by **your username** — set
  `bot-login` to it, otherwise the poster can't find (and dedupe against) its
  own threads.

## A fixed issue is not being resolved

Resolution is deliberately conservative. The agent only resolves when the
finding is gone **and** the code clearly changed (thread outdated, or its file
in the current diff). If the code is untouched or the thread is not marked
outdated, the agent leaves it open for a human. Resolved threads are never
reopened.

## Summary count says threads remain but I resolved them

If a resolve API call fails (e.g. the token can't resolve), the poster counts
the thread as still open in the summary's merge-gate note, rather than
reporting a false "all clear". Fix the token (classic PAT) to auto-resolve, or
resolve the remaining threads manually.
