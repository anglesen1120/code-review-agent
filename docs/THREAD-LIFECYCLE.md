# Thread lifecycle & the merge gate

This document explains how the agent decides what to post, what to resolve,
and why. The logic lives in `src/lifecycle.js` (`computeDelta`, `matchThread`,
`gateFails`) and is fully covered by unit tests; the platform adapters in
`src/platforms/*` only perform the API calls, and `bin/cra.js` orchestrates
them.

## The merge gate

The gate is GitHub's branch-protection rule **"Require conversation resolution
before merging"**. The agent never merges anything and never touches branch
protection; it simply creates (and resolves) review threads, and GitHub blocks
merge while any thread on the PR is unresolved.

On GitLab the equivalent switch is the project setting **Merge requests → All
threads must be resolved**; inline findings are MR discussions there. On CIs
without an adapter (Jenkins, Bitbucket, Azure) there are no threads, so the only
gate is `--fail-on` and the job's exit code.

```
PR opened   → agent posts threads            → merge BLOCKED
dev fixes   → workflow re-runs (synchronize) → agent auto-resolves fixed threads
dev replies → resolves manually              → agent NEVER reopens / re-posts
all resolved                                  → merge CLEAN
```

## Finding identity — the thread key

A finding becomes a thread with a stable key:

```
key = "<file>:<line>:<normalizedTitle>"
```

`normalizedTitle` lowercases, trims, collapses whitespace and strips trailing
punctuation. The key is what lets the poster recognize "this finding already
exists" across runs — even when the LLM re-words a title slightly.

## Posting: what gets a new thread

For each desired finding (Critical and Warning only; Info goes to the summary
but never becomes a thread), the poster checks, in order:

1. **Exact-key dedupe** — if a thread with the same key already exists (open
   *or* resolved), it is never re-posted. A dev-resolved thread stays resolved.
2. **Same-location fuzzy guard** — if an open, current thread sits at the same
   `path:line` with a *near-identical* title (LLM re-wording), treat it as
   already reported.
3. **Title dedupe across the file** — if any thread at the same path has a
   near-identical title (significant words overlap ≥ 50%), the issue is
   considered already reported even if the line shifted after a rework, and
   even if a dev resolved it (never re-nag).

Only findings that pass all three checks get posted as a new thread.

## Resolving: when a thread is auto-resolved

A thread is auto-resolved only when all of these hold:

- the analysis **succeeded** — a failed analysis posts nothing and resolves
  nothing, because it carries no evidence that anything was fixed;
- the issue was **not re-reported** this run (no exact-key match, no fuzzy
  title match);
- it is **open** (a dev-resolved thread is never touched); and
- the code **clearly changed**: the platform marks the thread outdated
  (`isOutdated`; GitHub only — GitLab has no such flag) **or** its file changed
  since the last reviewed commit; and
- the thread's file was **actually reviewed**: files skipped by the diff budget
  are not evidence of a fix, so their threads stay open.

"Changed since the last reviewed commit" is computed from the reviewed-SHA
marker (`<!-- code-review-agent:reviewed-sha=<sha> -->`) in the summary comment:
the adapter returns that SHA, and the CLI asks git for the files changed between
it and the head commit. When there is no previous reviewed SHA (first run, or a
summary written before the marker existed) or the SHA is unreachable
(force-push), the fallback is all files changed in the PR. Re-running on the
same head commit therefore resolves nothing except threads the platform reports
as outdated.

If the code is untouched and the thread is not outdated, the thread is left
open for a human. This is deliberately **conservative**: the agent would rather
leave a stale thread for a human to resolve than wrongly resolve a live issue.

Resolved threads are **never touched again** — never reopened, never re-posted.

## GitHub behaviors that shape the logic

### Line re-anchoring

When a file changes, GitHub **re-anchors** existing review threads to their new
positions. A thread that was created at line 18 can silently report line 16
after the fix commit shifts code above it. Consequences:

- Never trust that a thread's `line` is stable across runs — always re-match by
  key (file + line + title).
- The "same-location fuzzy guard" and title dedupe exist precisely because the
  analyzer's anchor lines drift between runs.

### Who can resolve

GitHub only permits **real user accounts** (classic PAT / OAuth) to call
`resolveReviewThread`. Both the actions `GITHUB_TOKEN` and fine-grained PATs
receive an HTTP 403 on this mutation even though they can post threads. This is
why the action requires a classic PAT for the auto-resolve feature — see
[`docs/SETUP.md`](SETUP.md).

### Author detection

The bot's login in API responses is `github-actions` (the app), sometimes
reported as `github-actions[bot]`. `isBotAuthor` accepts both, plus the exact
`bot-login` value, so a re-run of the same PR still finds the bot's own
threads whether the token is `GITHUB_TOKEN` or a classic PAT.

## Honest accounting

The poster recomputes the unresolved count from **actual** post/resolve
outcomes, not from the desired delta. If a resolve call fails (e.g. token
cannot resolve), the thread is still counted as open in the summary's
merge-gate note, so a reviewer is never told "all clear" when threads remain.

## Failure modes

| Situation | Behavior |
| --- | --- |
| Inline post fails for one line | Degrades to summary-only for that finding; run succeeds. |
| No thread could be posted at all | Run fails with a clear token-permissions message (misconfiguration is visible). |
| Resolve fails (token cannot resolve) | Logged; thread stays open; summary count is honest. |
| Summary comment fails | Logged; threads are unaffected; run succeeds. |
| Commit status cannot be set (`--set-status`) | Logged; report files are still written; run exits 1. |
| Analysis fails (non-zero opencode exit, signal, or invalid JSON) | Retry once; then nothing is posted or resolved, the previous reviewed-SHA marker is kept, the summary records the failure, and `--fail-on` (anything but `none`) exits 1. |
| File skipped by the diff budget | Listed in the summary notes; its threads stay open, never auto-resolved. |
| Whole diff over budget | Nothing posted or resolved; summary says the diff was not reviewed; exit 1 regardless of `--fail-on`. |
| Nothing could be posted at all | Exit 1 even with `--fail-on none`, so a misconfigured token is visible. |
| Finding outside a diff hunk | Summary only; Critical/Warning still count for `--fail-on`. |
