// Deterministic poster for the code review agent. Zero runtime dependencies.
//
//   node post-review.js fetch   — GraphQL: read bot-authored review threads -> existing_threads.json
//   node post-review.js apply   — load findings + existing threads, post/resolve/update summary/status
//
// The poster never calls an LLM and never executes text from threads/comments —
// it only matches normalized string keys (prompt-injection boundary).
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateFindings } from "./validate.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function normalizeTitle(t) {
  return String(t).trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
}

export function threadKey(f) {
  return `${f.file}:${f.line}:${normalizeTitle(f.title)}`;
}

export const rank = { Critical: 3, Warning: 2, Info: 1 };

const significant = (t) => normalizeTitle(t).split(" ").filter((w) => w.length > 2);

// Fuzzy title similarity for LLM re-wordings ("Parameterize SQL query to
// prevent SQL injection in getUser" vs "SQL injection via string concatenation
// in getUser"). Strict enough that distinct issues rarely match.
export function similarTitle(a, b) {
  const wa = significant(a ?? "");
  const wb = significant(b ?? "");
  if (wa.length === 0 || wb.length === 0) return false;
  const shared = wa.filter((w) => wb.includes(w)).length;
  if (shared >= 3 && shared >= Math.min(wa.length, wb.length) / 2) return true;
  const na = normalizeTitle(a ?? "");
  const nb = normalizeTitle(b ?? "");
  return na.length > 3 && (nb.startsWith(na) || na.startsWith(nb));
}

// Fuzzy guard: if an open, current thread sits at the same path:line with a
// near-identical title, treat the finding as already reported (LLM re-wording).
export function sameLocationGuard(thread, finding) {
  if (!thread || thread.path !== finding.file) return false;
  if (thread.line !== finding.line) return false;
  return similarTitle(thread.title, finding.title);
}

/**
 * Core lifecycle logic. Pure and deterministic.
 * @returns {{toPost: object[], toResolve: object[], unresolvedCount: number, counts: object}}
 */
export function computeDelta(findings, existingThreads, changedFiles) {
  const desired = new Map(); // key -> finding, highest severity wins
  const counts = { Critical: 0, Warning: 0, Info: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    if (f.severity !== "Critical" && f.severity !== "Warning") continue;
    const k = threadKey(f);
    const cur = desired.get(k);
    if (!cur || rank[f.severity] > rank[cur.severity]) desired.set(k, f);
  }

  // All threads by key (open AND resolved): a finding whose key was ever posted
  // is never re-posted — a dev-resolved thread stays resolved, never re-nagged.
  const allByKey = new Map(existingThreads.map((t) => [t.key, t]));
  const openCurrentByPathLine = new Map();
  for (const t of existingThreads) {
    if (!t.isResolved && !t.isOutdated) openCurrentByPathLine.set(`${t.path}:${t.line}`, t);
  }

  // A finding whose issue was already reported at the same path with a
  // near-identical title is never re-posted — even if the line shifted after a
  // rework, and even if a dev resolved it (never re-nag).
  const alreadyReportedByTitle = (f) =>
    existingThreads.some((t) => t.path === f.file && similarTitle(t.title ?? "", f.title));

  const toPost = [];
  for (const f of desired.values()) {
    if (allByKey.has(threadKey(f))) continue; // already reported -> leave open (or dev-resolved)
    const same = openCurrentByPathLine.get(`${f.file}:${f.line}`);
    if (same && sameLocationGuard(same, f)) continue; // fuzzy duplicate guard
    if (alreadyReportedByTitle(f)) continue; // same issue, re-worded or line shifted
    toPost.push(f);
  }

  const toResolve = [];
  for (const t of existingThreads) {
    if (t.isResolved) continue; // dev-resolved threads are NEVER reopened
    if (desired.has(t.key)) continue; // issue persists -> keep open
    // Conservative: only auto-resolve when the code clearly changed.
    if (t.isOutdated || changedFiles.includes(t.path)) toResolve.push(t);
  }

  const resolveIds = new Set(toResolve.map((t) => t.id));
  const remainingOpen = existingThreads.filter((t) => !t.isResolved && !resolveIds.has(t.id)).length;
  const unresolvedCount = remainingOpen + toPost.length;

  return { toPost, toResolve, unresolvedCount, counts };
}

export function markdownThread(f) {
  return [
    `**${f.severity} · ${f.category}** — ${f.title}`,
    "",
    f.description,
    "",
    "**Suggestion:**",
    f.suggestion,
    "",
    "<!-- code-review-agent -->",
  ].join("\n");
}

export function markdownSummary({ summary, findings, headSha, prNumber, owner, repo, unresolvedCount }) {
  const link = (f) =>
    `[${f.file}:${f.line}](https://github.com/${owner}/${repo}/blob/${headSha}/${f.file}#L${f.line})`;
  const groups = { Critical: [], Warning: [], Info: [] };
  for (const f of findings) groups[f.severity]?.push(f);
  const lines = [
    "<!-- code-review-agent:summary -->",
    "## Code Review Summary",
    "",
    summary,
    "",
    `Reviewed \`${headSha}\`${prNumber ? ` (PR #${prNumber})` : ""} · **Critical: ${groups.Critical.length} · Warning: ${groups.Warning.length} · Info: ${groups.Info.length}**`,
  ];
  for (const sev of ["Critical", "Warning", "Info"]) {
    if (groups[sev].length === 0) continue;
    lines.push("", `### ${sev}`);
    for (const f of groups[sev]) {
      lines.push(`- [${f.category}] **${f.title}** — ${link(f)} — ${f.description.split("\n")[0]}`);
    }
  }
  if (unresolvedCount > 0) {
    lines.push("", `> **Merge gate:** ${unresolvedCount} unresolved review thread(s) remain. Fix them (or reply and resolve) to unblock merge.`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub transport (gh CLI). Only used by fetch/apply in CI.
// ---------------------------------------------------------------------------

function gh(args, stdin) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input: stdin ?? "",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function graphql(query, variables) {
  const body = JSON.stringify({ query, variables });
  return JSON.parse(gh(["api", "graphql", "--input", "-"], body));
}

function rest(method, path, data) {
  const args = ["api", "-X", method, path];
  const body = data ? JSON.stringify(data) : undefined;
  if (body) args.push("--input", "-");
  return JSON.parse(gh(args, body ?? ""));
}

// ---------------------------------------------------------------------------
// Scratch dir + outputs
// ---------------------------------------------------------------------------

function scratchDir() {
  return `${process.env.RUNNER_TEMP || process.env.TMPDIR || "/tmp"}/cra`;
}
function scratch(name) {
  return `${scratchDir()}/${name}`;
}
function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function setOutput(name, value) {
  const p = process.env.GITHUB_OUTPUT;
  if (!p) return;
  appendFileSync(p, `${name}=${value}\n`);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const REVIEW_THREADS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line originalLine
          comments(first:1){ nodes{ author{ login } body } }
        }
      }
    }
  }
}`;

function titleFromBody(body) {
  const first = (body ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return first.replace(/^\*\*[^*]*\*\*\s*(—|-)?\s*/, "");
}

// GitHub reports the Actions GITHUB_TOKEN identity sometimes as `github-actions`
// (the app) and sometimes as `github-actions[bot]`; accept both so a re-run of
// the same PR still finds the bot's own threads.
export function isBotAuthor(login, botLogin) {
  if (!login) return false;
  if (login === botLogin) return true;
  const variants = new Set(["github-actions", "github-actions[bot]"]);
  return variants.has(login) && variants.has(botLogin);
}

async function fetchExistingThreads(owner, repo, number, botLogin) {
  const threads = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const res = await graphql(REVIEW_THREADS_QUERY, { owner, name: repo, number, cursor });
    const data = res.data?.repository?.pullRequest?.reviewThreads;
    if (!data) break;
    for (const node of data.nodes ?? []) {
      const root = node.comments?.nodes?.[0];
      if (!root || !isBotAuthor(root.author?.login, botLogin)) continue;
      const title = titleFromBody(root.body);
      const line = node.line ?? node.originalLine ?? 0;
      threads.push({
        id: node.id,
        key: threadKey({ file: node.path, line, title }),
        path: node.path,
        line,
        title,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
      });
    }
    hasNext = data.pageInfo?.hasNextPage ?? false;
    cursor = data.pageInfo?.endCursor ?? null;
  }
  return threads;
}

async function cmdFetch() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const number = Number(process.env.PR_NUMBER);
  if (!owner || !repo || !number) {
    console.error("post-review: GITHUB_REPOSITORY and PR_NUMBER are required");
    process.exit(2);
  }
  // The GitHub Actions GITHUB_TOKEN is a fine-grained token that cannot read
  // GET /user (HTTP 403). Its identity in API responses is `github-actions`
  // (the app), so default BOT_LOGIN to that; a personal access token user can
  // override via the bot-login input.
  const botLogin = process.env.BOT_LOGIN || "github-actions";
  const threads = await fetchExistingThreads(owner, repo, number, botLogin);
  writeFileSync(scratch("existing_threads.json"), JSON.stringify({ botLogin, threads }, null, 2));
  console.log(`post-review: found ${threads.length} bot thread(s) as ${botLogin}`);
}

async function postReview(owner, repo, number, headSha, comments) {
  return rest("POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, {
    commit_id: headSha,
    event: "COMMENT",
    body: "Automated review from code-review-agent.",
    comments,
  });
}

async function resolveThread(id) {
  await graphql(
    "mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }",
    { id },
  );
}

async function upsertSummaryComment(owner, repo, number, body) {
  const comments = await rest("GET", `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  const existing = comments.find((c) => c.body.startsWith("<!-- code-review-agent:summary -->"));
  if (existing) {
    await rest("PATCH", `repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    await rest("POST", `repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }
}

async function cmdApply() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const number = Number(process.env.PR_NUMBER);
  const headSha = process.env.HEAD_SHA;
  if (!owner || !repo || !number || !headSha) {
    console.error("post-review: GITHUB_REPOSITORY, PR_NUMBER and HEAD_SHA are required");
    process.exit(2);
  }

  const findingsData = readJSON(scratch("findings.json")) ?? { summary: "Analysis unavailable.", findings: [] };
  const validation = validateFindings(findingsData);
  if (!validation.ok) {
    console.error("post-review: findings failed validation: " + validation.errors.join("; "));
  }
  const existing = readJSON(scratch("existing_threads.json")) ?? { threads: [] };
  const changedFiles = readJSON(scratch("changed_files.json")) ?? [];

  const { toPost, toResolve, unresolvedCount, counts } = computeDelta(
    findingsData.findings,
    existing.threads ?? [],
    changedFiles,
  );

  let reviewId = null;
  if (toPost.length > 0) {
    try {
      reviewId = (await postReview(owner, repo, number, headSha,
        toPost.map((f) => ({ path: f.file, line: f.line, side: "RIGHT", body: markdownThread(f) })))).id;
    } catch {
      // Whole-review failed (likely one invalid line anchor). Retry per comment,
      // dropping the ones GitHub rejects; those findings still reach the summary.
      for (const f of toPost) {
        try {
          reviewId = (await postReview(owner, repo, number, headSha,
            [{ path: f.file, line: f.line, side: "RIGHT", body: markdownThread(f) }])).id;
        } catch {
          console.error(`post-review: could not post inline comment at ${f.file}:${f.line}; added to summary only`);
        }
      }
    }
  }

  for (const t of toResolve) {
    try {
      await resolveThread(t.id);
    } catch (e) {
      console.error(`post-review: could not resolve thread ${t.id}: ${e.message}`);
    }
    await sleep(300);
  }

  const summaryBody = markdownSummary({
    summary: findingsData.summary,
    findings: findingsData.findings,
    headSha,
    prNumber: number,
    owner,
    repo,
    unresolvedCount,
  });
  await upsertSummaryComment(owner, repo, number, summaryBody);

  if (process.env.SET_STATUS === "true") {
    const state = unresolvedCount > 0 ? "failure" : "success";
    await rest("POST", `repos/${owner}/${repo}/statuses/${headSha}`, {
      state,
      context: "code-review-agent",
      description: `${unresolvedCount} unresolved review thread(s) remain.`,
    });
  }

  console.log(`post-review: posted ${toPost.length}, resolved ${toResolve.length}, unresolved ${unresolvedCount}`);
  setOutput("findings-count", String(findingsData.findings.length));
  setOutput("unresolved-count", String(unresolvedCount));
  setOutput("review-id", String(reviewId ?? ""));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "fetch") {
    await cmdFetch();
  } else if (cmd === "apply") {
    await cmdApply();
  } else {
    console.error("usage: node post-review.js fetch|apply");
    process.exit(2);
  }
}
