# Troubleshooting

Common problems and how to diagnose them. Start with the job log: the CLI logs
under the `cra:` prefix, the analyzer prints an `opencode stderr (tail)` and
`opencode events (tail)` block after its second failed attempt, and the summary
comment carries a `Notes` section listing skipped files, dropped findings and
posting failures.

## Exit codes

| Exit | Likely cause |
| --- | --- |
| `0` | Review completed; `--fail-on` did not match (or is `none`). |
| `1` | Open issue matched `--fail-on`; the analysis failed while `--fail-on` is set; no thread could be posted at all; existing threads could not be read; the commit status could not be set with `--set-status`; or the whole diff exceeded `--max-diff-bytes` and nothing was reviewed. |
| `2` | Usage/configuration: unknown flag value, no base revision, missing platform token or MR/PR context, unreadable event payload. |

## `Unable to resolve action anglesen1120/code-review-agent`

The action repository must be **public** for
`uses: anglesen1120/code-review-agent@v1` to work from any repo. A private
action repo can only be used from repos in the same owner/org on a paid plan.
Make it public, or publish the action elsewhere (or use the Docker image).

## `Resource not accessible by integration` (HTTP 403) on resolve

The built-in `GITHUB_TOKEN` can post threads but **cannot resolve them**. This
is a GitHub platform restriction. To enable auto-resolve, supply a **classic PAT
with the `repo` scope** via `github-token` and set `bot-login` to that account's
username. See [`SETUP.md`](SETUP.md).

## `Resource not accessible by personal access token` (HTTP 403)

The fine-grained PAT equivalent. Even with Pull requests: write, a fine-grained
PAT **cannot** call `resolveReviewThread`; it can post threads and comments. Use
a classic PAT for auto-resolve.

If you are not trying to auto-resolve and still see this on every write:

- The fine-grained token may lack **repository access** — grant the repo (or
  *All repositories*).
- Permissions may be **Read-only** — Contents: read, Pull requests: read/write,
  Issues: read/write (for the summary comment), Statuses: read/write for
  `--set-status`.

## Threads are posted but merge is still green

Merge gating depends on branch protection, not on the action. On the default
branch enable **Require a pull request before merging** and **Require
conversation resolution before merging** (Settings → Branches → Add rule). If
the comparison is the `code-review-agent` commit status instead, remember it is
only set with `--set-status` and needs `statuses: write`.

On GitLab, enable **Settings → Merge requests → All threads must be resolved**
or add `--fail-on critical` to the job; otherwise a green pipeline does not
reflect open discussions.

Note: GitHub's own **Copilot Code Review** also creates threads that block
merge. If you don't use it, disable it in repo settings; it is separate from
this agent.

## `cra: no review thread could be posted — check the token's write permissions.`

The token could not deliver any inline thread, so the run exits `1` (even with
`--fail-on none`) instead of silently posting nothing. Check
`pull-requests: write` / GitLab Developer+ role with `api` scope, and repository
access for fine-grained tokens.

## Analysis failed (`analysis-failed=true`)

The analyzer retries once, then returns an error. **Nothing is posted and
nothing is resolved**: existing threads keep blocking merge, the summary records
the failure, the reviewed-SHA marker keeps its previous value (or is omitted),
and `--fail-on` (anything but `none`) exits `1`. An opencode process that exits
non-zero or is killed counts as a failed attempt even when it printed valid JSON.
Common causes:

- **Wrong or retired model.** The log shows `provider error: 400 … Model is
  unavailable`. Providers retire model ids (in November 2026 OpenCode Go
  rejected `deepseek-v4-flash` and no longer listed it in `/models`; the
  default is now `go/deepseek-v4.1-flash`). List the
  ids your key can use with `GET <base-url>/models` and set `model`/`CRA_MODEL`.
  A non-retryable provider error skips the second attempt.
- **Missing key.** `CRA_API_KEY` (or the legacy `DEEPSEEK_API_KEY`) is empty —
  the log says `API key not configured`.
- **Provider outage, rate limit or timeout.** Check the `opencode stderr (tail)`
  block; raise `CRA_ANALYZE_TIMEOUT_MS` if the model is slow (default 900000).
- **opencode missing.** `cannot start opencode: … ENOENT` — install
  `opencode-ai@1.18.18` (the action and image do this) or set
  `CRA_OPENCODE_BIN`.
- **Agent cannot read the scratch dir.** The generated `opencode.json` allows
  `external_directory` only for the scratch dir. If you forked the tool, verify
  `buildOpencodeConfig` still emits that rule.

## Model output was rejected (`analysis produced invalid findings`)

The extractor tried the whole output, fenced blocks and balanced `{…}` spans,
then retried with a stricter instruction. If both attempts failed, the model is
not honouring the schema. Try a stronger model (`--model`), or inspect
`events.jsonl` / `opencode.err` in the scratch dir (`.review` for `analyze`,
`.cra` on GitLab, `$RUNNER_TEMP/cra` when set, otherwise a private
`cra-*` directory under the system temp dir — pass `--out-dir` to choose a
known path). These files are not redacted, so treat them as sensitive.

## `symlink(s) removed from analysis snapshot`

`git archive` preserves committed symlinks, and a symlink can point outside the
snapshot (`~/secret`, `/etc`, the checkout). The CLI removes every symlink after
extracting and reports the count in the summary notes. If a finding depends on
following a committed symlink, the model cannot see that target — check the
target file directly.

The snapshot itself is a private directory outside the checkout with its own
`git init`, deleted at the end of the run. It is not `<out-dir>/src`; scratch
files (`pr.diff`, `findings.json`, `existing_threads.json`, `result.json`,
`opencode.json`, `events.jsonl`, `opencode.err`) stay in the out-dir.

## No threads at all, but the summary exists

- **Info findings never become threads** — only Critical and Warning.
- **Findings outside diff hunks go to the summary only.** The reviewer may
  report an issue on an unchanged line; GitHub and GitLab cannot anchor a
  comment there. Critical/Warning ones still count for `--fail-on`.

## Threads are re-posted, or the agent does not recognise its own threads

Check the bot identity:

- With `GITHUB_TOKEN`, threads are authored by `github-actions` — keep the
  default `bot-login`.
- With a classic PAT, threads are authored by **your username** — set
  `bot-login`, otherwise the adapter cannot find (or dedupe against) its own
  threads.
- Only threads whose root comment carries the agent marker are considered.
  Threads created by other tools or by humans are ignored by design.

## A fixed issue is not being resolved

Resolution is deliberately conservative. A thread is auto-resolved only when
the analysis succeeded, the issue was not re-reported, the thread is open, and
either the platform marks it outdated or **its file changed since the last
reviewed commit**. That commit comes from the reviewed-SHA marker in the summary
comment; on a first run, a summary without the marker, or an unreachable SHA
after a force-push, the fallback is all files changed in the PR. A re-run on the
same head commit resolves nothing except outdated threads. Resolved threads are
never reopened.

## `cra: cannot fetch … (use a full clone / fetch-depth: 0)`

The diff base is not in the clone. Set `fetch-depth: 0` (GitHub), `GIT_DEPTH:
"0"` (GitLab), `clone: depth: full` (Bitbucket), `fetchDepth: 0` (Azure), or
fetch the target branch explicitly as the Jenkins template does.

## GitLab: `401 Unauthorized` / `403 Forbidden`

- `GITLAB_TOKEN` missing or expired → exit `2` before analysis.
- `CI_JOB_TOKEN` is rejected by design: it cannot create MR discussions. Use a
  project/group access token with role Developer+ and the `api` scope.
- Token scope `read_api` can read but not post.

## GitLab: job runs on branch pipelines and exits 2

The adapter requires a merge-request pipeline (`CI_MERGE_REQUEST_IID`). Keep the
template's `rules: - if: $CI_PIPELINE_SOURCE == "merge_request_event"`.

## Jenkins: container exits immediately

Jenkins starts the container with its own command, so an image `ENTRYPOINT`
breaks it (`cra cat` → exit 2). The template passes
`args '--entrypoint= -e HOME=/tmp'`; keep it, and keep `HOME` writable for the
uid Jenkins uses.

## Azure: container job fails to start or cannot write reports

Azure container jobs expect an image **without** `ENTRYPOINT` and run steps with
`docker exec`. The template clears it with `options: '--entrypoint=""'` and runs
as root (`-u 0`) so the SARIF/Markdown files land in the agent-owned workspace
mount. On a self-hosted pool you can run as the uid that owns the clone instead
(`-u 1000`); if your policy forbids root containers, publish to a path the image
user owns and chown the staging directory first.

## Azure: private repository — `git fetch` fails or needs a token

`persistCredentials: false` removes the job token from `.git/config`, so a later
`git fetch` cannot authenticate. The template avoids that entirely:
`fetchDepth: 0` fetches the full history and `origin/<target>` is already there,
so the review needs no remote access. Do not add
`http.extraheader`/`System.AccessToken` to the `cra` step — the reviewer only
needs `CRA_API_KEY`.

## Bitbucket: permission denied writing `cra-report.md`

The Pipelines agent clones the workspace as its own user. The template sets
`run-as-user: "0"`; if you must run non-root, point `run-as-user` at a uid that
owns the workspace.

## The diff is huge and some files were skipped

The summary `Notes` section lists every file skipped by the diff budget
(`--max-diff-bytes`, default 250000 bytes). Raise the budget, or exclude more
paths with `--exclude`/`CRA_EXCLUDE`. Skipping is reported, never silent.

Threads on skipped files are **kept open**: an unreviewed file is not evidence
that an issue was fixed. If the whole diff is over budget, nothing is posted or
resolved, the summary says `Diff over <N> bytes: not reviewed.`, the
reviewed-SHA marker does not advance, and the run exits `1` regardless of
`--fail-on` — there is no evidence to gate on.

## `cra: commit status could not be set.`

`--set-status` was requested and the status API call failed (missing
`statuses: write`, protected branch, or a transient platform error). Report files
and the summary are still written, then the run exits `1`, because a required
delivery step failed. Fix the token permission or drop `--set-status`.

## Summary count says threads remain but I resolved them

If a resolve call fails (e.g. the token cannot resolve), the run counts the
thread as still open rather than reporting a false "all clear". Fix the token,
or resolve the remaining threads manually. A failed summary comment is logged
but never fails the run; the threads are the gate.
