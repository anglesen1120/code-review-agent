import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  threadKey,
  normalizeTitle,
  sameLocationGuard,
  markdownThread,
  markdownSummary,
} from "../scripts/post-review.js";

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
    headSha: "abc123",
    prNumber: 7,
    owner: "o",
    repo: "r",
    unresolvedCount: 1,
  });
  assert.match(md, /<!-- code-review-agent:summary -->/);
  assert.match(md, /### Critical/);
  assert.match(md, /https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/a\.cs#L42/);
  assert.match(md, /### Info/);
  assert.match(md, /1 unresolved review thread\(s\) remain/);
});
