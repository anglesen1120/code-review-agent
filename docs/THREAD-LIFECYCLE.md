# Thread lifecycle & the merge gate

This document explains how the agent decides what to post, what to resolve,
and why. The logic lives in `scripts/post-review.js` (`computeDelta` and the
`apply` subcommand) and is fully covered by unit tests.

## The merge gate

The gate is GitHub's branch-protection rule **"Require conversation resolution
before merging"**. The agent never merges anything and never touches branch
protection; it simply creates (and resolves) review threads, and GitHub blocks
merge while any thread on the PR is unresolved.

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

A thread is a candidate for resolution only when:

- it is **open**, and
- its key is **not** in the current desired set (the finding is gone), and
- the code **clearly changed** — either the thread is outdated
  (`isOutdated`) **or** its file is in the current diff's changed-files list.

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
| Analysis produces invalid JSON | Retry once, then degrade to empty findings + error marker; summary still updates. |
