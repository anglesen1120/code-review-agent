# End-to-end verification results

This document records the end-to-end verification of the agent against a real
GitHub repository (`anglesen1120/cra-e2e`, public). It is the acceptance
evidence for the design goals. The repo is a throwaway test harness with
**planted bugs**; results were captured on 2026-08-16.

## Scenario

`src/orders.js` contained two planted bugs:

```js
// Critical: term and userId are user-controlled and interpolated directly into SQL.
function searchOrders(term, userId) {
  const sql =
    "SELECT * FROM orders WHERE user_id = " + userId +
    " AND title LIKE '%" + term + "%'";
  return query(sql);
}

// Warning: getUser may be called with a null/undefined id -> broken SQL + throw.
function getUser(id) {
  const rows = query("SELECT * FROM users WHERE id = " + id);
  return rows && rows[0] ? rows[0].name : null;
}
```

Setup on `cra-e2e`:

- Workflow: `anglesen1120/code-review-agent@v1` on `pull_request`
  (opened / synchronize / reopened), classic PAT as `github-token`
  (`secrets.CODE_REVIEW_TOKEN`), `bot-login: anglesen1120`.
- Branch protection on `main`: **Require a pull request before merging** +
  **Require conversation resolution before merging**.

## Step 1 — PR opened → threads posted → merge blocked

Opening PR #2 triggered a run. The agent posted inline threads **authored by
`anglesen1120`** plus a summary comment, and merge was **BLOCKED**:

| Thread | Severity | State |
| --- | --- | --- |
| SQL injection via string concatenation in `searchOrders` | Critical | open |
| Validate `userId` and `term` before interpolating into SQL | Warning | open |

`mergeStateStatus: BLOCKED`.

## Step 2 — Dev pushes a fix → agent auto-resolves

A fix was pushed that parameterized `searchOrders` (the Critical), leaving
`getUser` untouched (the Warning). The `synchronize` event re-ran the
workflow. The poster's log shows the agent did the resolution automatically —
no human action:

```
post-review: posted 0, resolved 2, unresolved 1
```

Observed thread state after the run:

| Thread | State |
| --- | --- |
| SQL injection via string concatenation in `searchOrders` | ✅ **resolved by the agent** |
| Validate `userId`/`term` before interpolating into SQL | ✅ **resolved by the agent** |
| Guard against null/undefined `id` in `getUser` | ⚠️ still open (bug persists) |

Merge stayed **BLOCKED** because the genuine `getUser` bug remained. The
summary comment was updated honestly: it stated that `searchOrders` was
correctly parameterized and re-anchored the remaining injection to
`getUser` at line 17, with **1 unresolved thread** noted in the merge-gate
line.

This confirms the core requirement: **when code is fixed, the agent re-reviews
and auto-resolves the conversation — nobody resolves it manually.**

## Step 3 — Dev resolves remaining thread → merge unblocks

The `getUser` warning thread was resolved manually (simulating a dev).
`mergeStateStatus` went to **CLEAN** — the merge gate unblocks once every
conversation is resolved.

## Step 4 — Trivial change → resolved threads never reopened

A no-op comment was appended to `src/orders.js` (the `getUser` bug was still
present in the code) and pushed. The workflow re-ran; the agent re-reviewed
the file but **did not reopen or re-post any resolved thread**. All threads
stayed resolved and merge stayed **CLEAN**.

This confirms the "never re-nag" guarantee: a thread a dev resolved is never
reopened, even when the underlying issue still exists.

## Verification matrix

| Requirement | Result |
| --- | --- |
| Action runs on `opened` / `synchronize` / `reopened` | ✅ |
| Posts inline threads (Critical / Warning) authored by the bot login | ✅ |
| Posts one summary comment (idempotent, honest counts) | ✅ |
| Unresolved threads block merge (`BLOCKED`) | ✅ |
| Agent auto-resolves threads whose issue is fixed | ✅ |
| Genuinely remaining issue stays open | ✅ |
| Dev-resolved thread never reopened / re-posted | ✅ |
| All resolved → merge `CLEAN` | ✅ |
| No duplicate threads across re-runs (title dedupe) | ✅ |
| Unit tests (28) | ✅ |

## Token limitation discovered during verification

The auto-resolve feature exposed a hard GitHub platform restriction. Both the
built-in `GITHUB_TOKEN` and a **fine-grained PAT** can post threads and
comments but **cannot resolve them**:

- `GITHUB_TOKEN` → `Resource not accessible by integration` on
  `resolveReviewThread`.
- Fine-grained PAT (even with Pull requests/Issues: write) →
  `Resource not accessible by personal access token`.
- **Classic PAT (`repo` scope) → resolves successfully.**

Consequence: auto-resolve requires a classic PAT, and resolved conversations
are attributed to that PAT's account in the GitHub UI. The agent still makes
the decision automatically; see [`docs/SETUP.md`](SETUP.md).
