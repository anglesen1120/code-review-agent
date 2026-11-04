import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../bin/cra.js";
import { markdownThread, parseThreadBody, threadKey } from "../src/lifecycle.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Repo with base commit (a.js 5 lines) and head commit (a.js line 3 changed, b.js added). */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cra-cli-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.js"), "l1\nl2\nl3\nl4\nl5\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a.js"), "l1\nl2\nCHANGED\nl4\nl5\n");
  writeFileSync(join(dir, "b.js"), "new\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

const F = (o = {}) => ({ severity: "Critical", category: "bug", file: "a.js", line: 3, title: "Broken thing", description: "d", suggestion: "s", ...o });
const okAnalysis = (findings, summary = "sum") => async () => ({ data: { summary, findings }, error: null, dropped: [] });

function fakePlatform({ threads = [], lastReviewedSha = null, postFails = false } = {}) {
  const calls = { posted: [], resolved: [], summary: null, status: null };
  const p = {
    name: "fake",
    prLabel: "PR",
    context: { prNumber: 7, baseSha: null, headSha: null, workspace: null },
    async fetchState() { return { threads, lastReviewedSha }; },
    async postThreads(items) {
      if (postFails) return { posted: [], failed: items.map((i) => ({ finding: i.finding, error: "403" })), reviewId: null };
      calls.posted.push(...items);
      return { posted: items.map((i) => i.finding), failed: [], reviewId: "R1" };
    },
    async resolveThread(t) { calls.resolved.push(t.id); },
    async upsertSummary(body) { calls.summary = body; },
    async setStatus(state, description) { calls.status = { state, description }; },
    fileUrl: (f, l) => `u/${f}#L${l}`,
  };
  return { p, calls };
}

const thread = (o) => {
  const t = { id: "T1", path: "a.js", line: 3, title: "Broken thing", severity: "Critical", isResolved: false, isOutdated: false, ...o };
  return { ...t, key: threadKey({ file: t.path, line: t.line, title: t.title }) };
};

async function review(repo, extraArgs, deps) {
  const logs = [];
  const outs = [];
  const outDir = mkdtempSync(join(tmpdir(), "cra-out-"));
  const code = await run(["review", "--base", repo.base, "--head", repo.head, "--out-dir", outDir, ...extraArgs], {
    env: { PATH: process.env.PATH },
    cwd: repo.dir,
    log: (m) => logs.push(m),
    out: (m) => outs.push(m),
    ...deps,
  });
  return { code, logs: logs.join("\n"), outs: outs.join("\n"), outDir };
}

test("usage errors exit 2", async () => {
  const repo = makeRepo();
  assert.equal((await review(repo, ["--fail-on", "bogus"], {})).code, 2);
  assert.equal(await run(["frobnicate"], { env: {}, log: () => {} }), 2);
  assert.equal(await run(["review", "--platform", "none"], { env: {}, cwd: repo.dir, log: () => {}, out: () => {} }), 2, "no base revision");
});

test("platform none: report files + fail-on gate", async () => {
  const repo = makeRepo();
  const sarif = join(repo.dir, "out.sarif");
  const cq = join(repo.dir, "cq.json");
  const r = await review(repo, ["--platform", "none", "--fail-on", "critical", "--sarif", sarif, "--codequality", cq], { analyze: okAnalysis([F()]) });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(readFileSync(sarif, "utf8")).runs[0].results.length, 1);
  assert.equal(JSON.parse(readFileSync(cq, "utf8"))[0].severity, "critical");
  assert.match(r.outs, /Broken thing/);
  const ok = await review(repo, ["--platform", "none", "--fail-on", "critical"], { analyze: okAnalysis([F({ severity: "Warning" })]) });
  assert.equal(ok.code, 0);
});

test("empty diff skips the LLM", async () => {
  const repo = makeRepo();
  let called = false;
  const r = await run(["review", "--platform", "none", "--base", repo.head, "--head", repo.head, "--out-dir", mkdtempSync(join(tmpdir(), "o-"))], {
    env: {}, cwd: repo.dir, log: () => {}, out: () => {}, analyze: async () => { called = true; },
  });
  assert.equal(r, 0);
  assert.equal(called, false);
});

test("anchored finding is posted; out-of-diff finding goes to summary notes only", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform();
  const r = await review(repo, [], {
    analyze: okAnalysis([F(), F({ line: 1, title: "Far away" }), F({ file: "zzz.js", line: 1, title: "Not in diff" })]),
    platformFactory: () => p,
  });
  assert.equal(r.code, 0);
  // a.js line 1 is a context line inside the -U5 hunk -> anchorable.
  assert.deepEqual(calls.posted.map((i) => `${i.finding.file}:${i.finding.line}:${i.anchor.type}`).sort(), ["a.js:1:context", "a.js:3:add"]);
  assert.match(calls.summary, /Outside the diff \(not posted inline\): Critical — Not in diff/);
  assert.equal(p.context.headSha, repo.head, "adapter context pinned to the reviewed commit");
  assert.match(calls.summary, new RegExp(`reviewed-sha=${repo.head}`));
});

test("failed analysis never resolves or posts, and fails closed with fail-on", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform({ threads: [thread()] });
  const failed = async () => ({ data: null, error: "provider down", dropped: [] });
  const r = await review(repo, ["--set-status"], { analyze: failed, platformFactory: () => p });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.resolved, []);
  assert.deepEqual(calls.posted, []);
  assert.match(calls.summary, /Analysis failed/);
  assert.match(calls.summary, /1 unresolved/);
  assert.equal(calls.status.state, "failure");
  const { p: p2 } = fakePlatform({ threads: [thread()] });
  assert.equal((await review(repo, ["--fail-on", "critical"], { analyze: failed, platformFactory: () => p2 })).code, 1);
});

test("fixed issue resolves only when its file changed since the last reviewed commit", async () => {
  const repo = makeRepo();
  // Same head already reviewed: nothing changed under the thread -> keep open.
  const same = fakePlatform({ threads: [thread()], lastReviewedSha: repo.head });
  await review(repo, [], { analyze: okAnalysis([]), platformFactory: () => same.p });
  assert.deepEqual(same.calls.resolved, []);
  // Last reviewed = base: a.js changed since -> resolve.
  const moved = fakePlatform({ threads: [thread()], lastReviewedSha: repo.base });
  const r = await review(repo, ["--fail-on", "critical"], { analyze: okAnalysis([]), platformFactory: () => moved.p });
  assert.deepEqual(moved.calls.resolved, ["T1"]);
  assert.equal(r.code, 0);
});

test("persisting re-worded issue keeps its thread open and the gate closed", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform({ threads: [thread({ line: 4, title: "Broken thing in parser loop" })], lastReviewedSha: repo.base });
  const r = await review(repo, ["--fail-on", "critical"], { analyze: okAnalysis([F({ title: "Broken thing in the parser loop" })]), platformFactory: () => p });
  assert.deepEqual(calls.resolved, []);
  assert.deepEqual(calls.posted, []);
  assert.equal(r.code, 1);
});

test("nothing deliverable exits 1", async () => {
  const repo = makeRepo();
  const { p } = fakePlatform({ postFails: true });
  const r = await review(repo, [], { analyze: okAnalysis([F()]), platformFactory: () => p });
  assert.equal(r.code, 1);
  assert.match(r.logs, /no review thread could be posted/);
});

test("analyzer runs in a clean snapshot of head: tracked files only, no .git", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, ".env"), "SECRET=1\n"); // untracked
  let seen;
  const r = await review(repo, ["--platform", "none"], {
    analyze: async ({ workspace }) => {
      seen = { git: existsSync(join(workspace, ".git")), env: existsSync(join(workspace, ".env")), a: readFileSync(join(workspace, "a.js"), "utf8") };
      return { data: { summary: "s", findings: [] }, error: null, dropped: [] };
    },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(seen, { git: false, env: false, a: "l1\nl2\nCHANGED\nl4\nl5\n" });
});

test("dry-run prints the plan and writes nothing to the platform", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform({ threads: [thread({ id: "OLD", line: 2, title: "Other stale issue" })], lastReviewedSha: repo.base });
  const r = await review(repo, ["--dry-run"], { analyze: okAnalysis([F()]), platformFactory: () => p });
  const plan = JSON.parse(r.outs);
  assert.equal(plan.post.length, 1);
  assert.equal(plan.resolve.length, 1);
  assert.equal(calls.summary, null);
  assert.deepEqual(calls.resolved, []);
  assert.ok(existsSync(join(r.outDir, "findings.json")));
});

test("thread bodies written by markdownThread are recognised on the next run", () => {
  assert.equal(parseThreadBody(markdownThread(F())).title, "Broken thing");
});
