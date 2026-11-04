import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  threadKey,
  normalizeTitle,
  sameLocationGuard,
  similarTitle,
  markdownThread,
  markdownSummary,
  parseThreadBody,
  parseReviewedSha,
  gateFails,
  sanitize,
} from "../src/lifecycle.js";

const F = (o = {}) => ({
  severity: "Warning",
  category: "bug",
  file: "a.cs",
  line: 10,
  title: "Some bug",
  description: "desc",
  suggestion: "fix",
  ...o,
});
const T = (o = {}) => ({
  id: "t1",
  key: "a.cs:10:some bug",
  path: "a.cs",
  line: 10,
  title: "Some bug",
  isResolved: false,
  isOutdated: false,
  ...o,
});

// ---- helpers ----

test("normalizeTitle strips case/whitespace/trailing punctuation", () => {
  assert.equal(normalizeTitle("  SQL Injection!!!  "), "sql injection");
  assert.equal(normalizeTitle("missing null check."), "missing null check");
});

test("threadKey normalizes file:line:title", () => {
  assert.equal(
    threadKey(F({ file: "src/X.cs", line: 42, title: "SQL injection!" })),
    "src/X.cs:42:sql injection",
  );
});

// ---- computeDelta ----

test("empty existing threads -> all Critical/Warning posted, none resolved", () => {
  const { toPost, toResolve, unresolvedCount, counts } = computeDelta(
    [
      F({ severity: "Critical", file: "a.cs", line: 5, title: "SQL injection" }),
      F({ file: "b.cs", line: 9, title: "Missing null check" }),
      F({ severity: "Info", file: "a.cs", line: 1, title: "Style nit" }),
    ],
    [],
    [],
  );
  assert.equal(toPost.length, 2); // Critical + Warning; Info never posted
  assert.equal(toResolve.length, 0);
  assert.equal(unresolvedCount, 2);
  assert.deepEqual(counts, { Critical: 1, Warning: 1, Info: 1 });
});

test("same key with different severities -> highest severity wins, single post", () => {
  const { toPost } = computeDelta(
    [F({ severity: "Warning", line: 10 }), F({ severity: "Critical", line: 10 })],
    [],
    [],
  );
  assert.equal(toPost.length, 1);
  assert.equal(toPost[0].severity, "Critical");
});

test("exact key match -> not re-posted, not resolved, stays open", () => {
  const findings = [F({ severity: "Critical", title: "SQL injection" })];
  const key = threadKey(findings[0]);
  const threads = [T({ id: "r1", key, title: "SQL injection" })];
  const { toPost, toResolve, unresolvedCount } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
  assert.equal(toResolve.length, 0);
  assert.equal(unresolvedCount, 1);
});

test("dev-resolved thread is never reopened and never re-posted", () => {
  const findings = [F({ severity: "Critical", title: "SQL injection" })];
  const key = threadKey(findings[0]);
  const threads = [T({ id: "r1", key, title: "SQL injection", isResolved: true })];
  const { toPost, toResolve, unresolvedCount } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0); // don't nag a resolved thread
  assert.equal(toResolve.length, 0); // never touch resolved
  assert.equal(unresolvedCount, 0);
});

test("absent finding + outdated thread -> resolved", () => {
  const threads = [T({ id: "r1", key: "a.cs:10:some bug", isOutdated: true })];
  const { toPost, toResolve, unresolvedCount } = computeDelta([], threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
  assert.equal(toResolve.length, 1);
  assert.equal(toResolve[0].id, "r1");
  assert.equal(unresolvedCount, 0);
});

test("absent finding + unchanged file -> NOT auto-resolved (conservative)", () => {
  const threads = [T({ id: "r1", key: "a.cs:10:some bug", isOutdated: false })];
  const { toResolve, unresolvedCount } = computeDelta([], threads, ["other.cs"]);
  assert.equal(toResolve.length, 0);
  assert.equal(unresolvedCount, 1);
});

test("absent finding + file changed -> resolved", () => {
  const threads = [T({ id: "r1", key: "a.cs:10:some bug", isOutdated: false })];
  const { toResolve } = computeDelta([], threads, ["a.cs"]);
  assert.equal(toResolve.length, 1);
});

test("persisting finding keeps open thread, does not resolve", () => {
  const findings = [F({ title: "Some bug" })];
  const threads = [T({ id: "r1", key: "a.cs:10:some bug" })];
  const { toPost, toResolve, unresolvedCount } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
  assert.equal(toResolve.length, 0);
  assert.equal(unresolvedCount, 1);
});

test("fuzzy guard: same location + near-identical title blocks re-post", () => {
  const findings = [F({ severity: "Critical", line: 42, title: "SQL injection via string concat" })];
  const threads = [T({ id: "r1", path: "a.cs", line: 42, title: "SQL injection via string concatenation" })];
  const { toPost } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
});

test("fuzzy guard does not block a genuinely different issue at same line", () => {
  const findings = [F({ line: 42, title: "Race condition on shared state" })];
  const threads = [T({ id: "r1", path: "a.cs", line: 42, title: "SQL injection via string concat" })];
  const { toPost } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 1);
});

test("sameLocationGuard unit behavior", () => {
  const thread = T({ path: "a.cs", line: 10, title: "missing null check" });
  assert.equal(sameLocationGuard(thread, F({ line: 10, title: "Missing null check! " })), true);
  assert.equal(sameLocationGuard(thread, F({ line: 11, title: "missing null check" })), false);
  assert.equal(sameLocationGuard(thread, F({ line: 10, title: "add cancellation token" })), false);
});

test("similarTitle matches LLM re-wordings of the same issue", () => {
  assert.equal(
    similarTitle(
      "Parameterize SQL query to prevent SQL injection in getUser",
      "SQL injection via string concatenation in getUser",
    ),
    true,
  );
  assert.equal(similarTitle("Race condition on shared state", "SQL injection via string concat"), false);
});

test("title-dedup suppresses a re-worded issue even when the line shifted", () => {
  // Old thread reported the getUser injection at line 19; after a rework the
  // same issue now sits at line 17 with a re-worded title. It must NOT be posted
  // again (no duplicate thread).
  const findings = [F({ severity: "Critical", file: "a.cs", line: 17, title: "SQL injection via string concatenation in getUser" })];
  const threads = [
    T({ id: "old", path: "a.cs", line: 19, title: "Parameterize SQL query to prevent SQL injection in getUser" }),
  ];
  const { toPost, toResolve, kept } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
  // Regression: the persisting issue's thread must stay open, not be
  // auto-resolved because the file changed (it used to vanish from the gate).
  assert.deepEqual(toResolve, []);
  assert.deepEqual(kept.map((t) => t.id), ["old"]);
});

test("title-dedup ignores a same-kind issue far away in the same file", () => {
  const findings = [F({ severity: "Critical", file: "a.cs", line: 200, title: "SQL injection via string concatenation in getOrder" })];
  const threads = [T({ id: "r", path: "a.cs", line: 9, title: "SQL injection via string concatenation in getUser", isResolved: true })];
  const { toPost } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 1);
});

test("title-dedup matches an outdated thread regardless of line distance", () => {
  const findings = [F({ file: "a.cs", line: 300, title: "Missing null check on request payload" })];
  const threads = [T({ id: "o", path: "a.cs", line: 5, title: "Missing null check on request payload", isOutdated: true })];
  const { toPost, toResolve, kept } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
  assert.equal(toResolve.length, 0);
  assert.equal(kept.length, 1);
});

test("title-dedup never re-nags an issue a dev already resolved", () => {
  const findings = [F({ severity: "Critical", file: "a.cs", line: 10, title: "SQL injection via string concatenation in getUser" })];
  const threads = [T({ id: "resolved", path: "a.cs", line: 9, title: "Parameterize SQL query to prevent SQL injection in getUser", isResolved: true })];
  const { toPost } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 0);
});

test("title-dedup does not block a genuinely different issue at the same path", () => {
  const findings = [F({ severity: "Critical", file: "a.cs", line: 10, title: "Race condition on shared state" })];
  const threads = [T({ id: "r1", path: "a.cs", line: 10, title: "SQL injection via string concatenation" })];
  const { toPost } = computeDelta(findings, threads, ["a.cs"]);
  assert.equal(toPost.length, 1);
});

// ---- markdown ----

test("markdownThread includes severity, category, suggestion, marker", () => {
  const md = markdownThread(F({ severity: "Critical", category: "security", title: "XSS" }));
  assert.match(md, /\*\*Critical · security\*\* — XSS/);
  assert.match(md, /Suggestion:/);
  assert.match(md, /<!-- code-review-agent -->/);
});

test("markdownSummary groups by severity, links lines, notes merge gate", () => {
  const md = markdownSummary({
    summary: "Looks risky.",
    findings: [
      F({ severity: "Critical", category: "security", file: "src/a.cs", line: 42, title: "XSS", description: "Bad input." }),
      F({ severity: "Info", title: "Style nit" }),
    ],
    headSha: "abc1234",
    prNumber: 7,
    unresolvedCount: 1,
    fileUrl: (file, line) => `https://example.test/blob/abc1234/${file}#L${line}`,
    notes: ["Diff over budget: big.js"],
    prLabel: "MR",
  });
  assert.ok(md.startsWith("<!-- code-review-agent:summary -->"));
  assert.equal(parseReviewedSha(md), "abc1234");
  assert.match(md, /### Critical/);
  assert.match(md, /\(MR #7\)/);
  assert.match(md, /https:\/\/example\.test\/blob\/abc1234\/src\/a\.cs#L42/);
  assert.match(md, /### Info/);
  assert.match(md, /Diff over budget: big\.js/);
  assert.match(md, /1 unresolved review thread\(s\) remain/);
});

test("markdownSummary without fileUrl renders plain locations", () => {
  const md = markdownSummary({ summary: "s", findings: [F({ file: "x.js", line: 3 })], headSha: "deadbeef", unresolvedCount: 0 });
  assert.match(md, /`x\.js:3`/);
  assert.doesNotMatch(md, /Merge gate/);
});

test("parseReviewedSha only trusts a body that starts with the summary marker", () => {
  assert.equal(parseReviewedSha("hi <!-- code-review-agent:reviewed-sha=abcdef1 -->"), null);
  assert.equal(parseReviewedSha(null), null);
});

test("parseThreadBody round-trips markdownThread severity and title", () => {
  const body = markdownThread(F({ severity: "Critical", category: "security", title: "SQL injection" }));
  assert.deepEqual(parseThreadBody(body), { severity: "Critical", title: "SQL injection" });
  assert.deepEqual(parseThreadBody("plain human comment"), { severity: undefined, title: "plain human comment" });
});

test("sanitize breaks @mentions and HTML comments from model output", () => {
  const s = sanitize("ping @octocat <!-- code-review-agent:summary --> mail a@b.com `@x`");
  assert.doesNotMatch(s, /<!--/);
  assert.match(s, /@\u200boctocat/);
  assert.match(s, /a@b\.com/);
  // A model title cannot spoof the thread marker.
  assert.doesNotMatch(markdownThread(F({ title: "x <!-- code-review-agent -->" })).split("\n")[0], /<!--/);
});

test("gateFails thresholds", () => {
  assert.equal(gateFails(["Warning"], "critical"), false);
  assert.equal(gateFails(["Warning"], "warning"), true);
  assert.equal(gateFails(["Critical"], "critical"), true);
  assert.equal(gateFails(["Info"], "warning"), false);
  assert.equal(gateFails(["Critical"], "none"), false);
  assert.equal(gateFails([], "warning"), false);
});
