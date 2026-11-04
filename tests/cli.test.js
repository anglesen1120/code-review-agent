import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCommits, run, safeConsole } from "../bin/cra.js";
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

test("analyzer runs in a private snapshot of head: tracked files only, own empty repo", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, ".env"), "SECRET=1\n"); // untracked
  let seen;
  const r = await review(repo, ["--platform", "none"], {
    analyze: async ({ workspace }) => {
      const gitConfig = existsSync(join(workspace, ".git", "config")) ? readFileSync(join(workspace, ".git", "config"), "utf8") : "";
      seen = {
        workspace,
        env: existsSync(join(workspace, ".env")),
        a: readFileSync(join(workspace, "a.js"), "utf8"),
        // The snapshot's own repo must not point anywhere (no CI token in a remote URL).
        remote: /\[remote|token|url\s*=/i.test(gitConfig),
      };
      return { data: { summary: "s", findings: [] }, error: null, dropped: [] };
    },
  });
  assert.equal(r.code, 0);
  assert.deepEqual({ env: seen.env, a: seen.a, remote: seen.remote }, { env: false, a: "l1\nl2\nCHANGED\nl4\nl5\n", remote: false });
  assert.equal(seen.workspace.startsWith(repo.dir + "/"), false, "snapshot lives outside the checkout");
  assert.equal(existsSync(seen.workspace), false, "snapshot is removed after the run");
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

/** Repo whose single changed file is far larger than the 1000-byte budget floor. */
function makeBigRepo({ withSmallChange = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cra-big-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.js"), "l1\nl2\nl3\nl4\nl5\n");
  writeFileSync(join(dir, "big.js"), Array.from({ length: 200 }, (_, i) => `old line ${i} padding padding\n`).join(""));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  if (withSmallChange) writeFileSync(join(dir, "a.js"), "l1\nl2\nCHANGED\nl4\nl5\n");
  writeFileSync(join(dir, "big.js"), Array.from({ length: 200 }, (_, i) => `new line ${i} padding padding padding\n`).join(""));
  git(dir, "commit", "-qam", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

test("an entirely over-budget diff reviews nothing: threads stay open and the run fails closed", async () => {
  const repo = makeBigRepo();
  const { p, calls } = fakePlatform({ threads: [thread({ path: "big.js", line: 2 })], lastReviewedSha: repo.base });
  let analyzed = false;
  const r = await review(repo, ["--max-diff-bytes", "1000", "--fail-on", "critical"], {
    analyze: async () => { analyzed = true; return okAnalysis([]); },
    platformFactory: () => p,
  });
  assert.equal(analyzed, false, "no model call when nothing is reviewable");
  assert.equal(r.code, 1);
  assert.deepEqual(calls.resolved, []);
  assert.deepEqual(calls.posted, []);
  assert.match(calls.summary, /not reviewed/i);
  assert.doesNotMatch(calls.summary, /No code changes/);
  // Nothing was reviewed, so the marker must not advance.
  assert.match(calls.summary, new RegExp(`reviewed-sha=${repo.base}`));
  assert.doesNotMatch(calls.summary, new RegExp(`reviewed-sha=${repo.head}`));
});

test("a change in a budget-skipped file is no evidence that its thread is fixed", async () => {
  const repo = makeBigRepo({ withSmallChange: true });
  const { p, calls } = fakePlatform({ threads: [thread({ path: "big.js", line: 2 })], lastReviewedSha: repo.base });
  const r = await review(repo, ["--max-diff-bytes", "1000"], { analyze: okAnalysis([]), platformFactory: () => p });
  assert.deepEqual(calls.resolved, [], "skipped file must not resolve its thread");
  assert.match(calls.summary, /1 unresolved/);
  assert.equal(r.code, 0);
});

test("a finding that escalates an existing thread fails the gate at its current severity", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform({ threads: [thread({ severity: "Warning" })], lastReviewedSha: repo.head });
  const r = await review(repo, ["--fail-on", "critical", "--set-status"], {
    analyze: okAnalysis([F({ severity: "Critical" })]),
    platformFactory: () => p,
  });
  assert.deepEqual(calls.resolved, []);
  assert.deepEqual(calls.posted, []);
  assert.equal(calls.status.state, "failure");
  assert.equal(r.code, 1);
});

test("an unanchored Critical finding sets the commit status to failure", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform();
  const r = await review(repo, ["--set-status"], {
    analyze: okAnalysis([F({ file: "zzz.js", line: 1, title: "Not in diff" })]),
    platformFactory: () => p,
  });
  assert.equal(calls.status.state, "failure");
  assert.equal(r.code, 0);
});

test("a failed analysis keeps the previous reviewed-sha marker", async () => {
  const repo = makeRepo();
  const { p, calls } = fakePlatform({ threads: [thread()], lastReviewedSha: repo.base });
  const r = await review(repo, [], { analyze: async () => ({ data: null, error: "boom", dropped: [] }), platformFactory: () => p });
  assert.equal(r.code, 0);
  assert.match(calls.summary, new RegExp(`reviewed-sha=${repo.base}`));
  assert.doesNotMatch(calls.summary, new RegExp(`reviewed-sha=${repo.head}`));
});

test("a failing status API call exits 1 after the reports are written", async () => {
  const repo = makeRepo();
  const { p } = fakePlatform();
  p.setStatus = async () => { throw new Error("403"); };
  const markdown = join(repo.dir, "report.md");
  const r = await review(repo, ["--set-status", "--markdown", markdown], { analyze: okAnalysis([F()]), platformFactory: () => p });
  assert.equal(r.code, 1);
  assert.match(r.logs, /commit status could not be set/);
  assert.ok(existsSync(markdown), "reports are written before exiting");
});

test("analyze of the working tree honours --exclude and the default exclusions", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo.dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo.dir, "node_modules", "pkg", "index.js"), "v1\n");
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "-qm", "dep");
  writeFileSync(join(repo.dir, "a.js"), "l1\nl2\nLOCAL\nl4\nl5\n");
  writeFileSync(join(repo.dir, "b.js"), "changed locally\n");
  writeFileSync(join(repo.dir, "node_modules", "pkg", "index.js"), "v2\n");
  let seen;
  const code = await run(["analyze", "--exclude", "b.js", "--out-dir", mkdtempSync(join(tmpdir(), "cra-out-"))], {
    env: { PATH: process.env.PATH },
    cwd: repo.dir,
    log: () => {},
    out: () => {},
    analyze: async ({ workspace, diffPath }) => {
      seen = { workspace, diff: readFileSync(diffPath, "utf8") };
      return { data: { summary: "s", findings: [] }, error: null, dropped: [] };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.workspace, repo.dir, "the working tree is analyzed in place");
  assert.match(seen.diff, /LOCAL/);
  assert.doesNotMatch(seen.diff, /b\.js/);
  assert.doesNotMatch(seen.diff, /node_modules/);
});

test("the analysis snapshot has no symlinks, lives outside the checkout and is removed", async () => {
  const repo = makeRepo();
  const outside = mkdtempSync(join(tmpdir(), "cra-outside-"));
  writeFileSync(join(outside, "secret.txt"), "leak\n");
  symlinkSync(join(outside, "secret.txt"), join(repo.dir, "notes.txt"));
  symlinkSync(outside, join(repo.dir, "hostsdir"));
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "-qm", "links");
  const head = git(repo.dir, "rev-parse", "HEAD");
  const outDir = mkdtempSync(join(tmpdir(), "cra-out-"));
  let snapshot;
  const code = await run(["review", "--platform", "none", "--base", repo.base, "--head", head, "--out-dir", outDir, "--markdown", join(outDir, "r.md")], {
    env: { PATH: process.env.PATH },
    cwd: repo.dir,
    log: () => {},
    out: () => {},
    analyze: async ({ workspace }) => {
      snapshot = workspace;
      assert.equal(existsSync(join(workspace, "notes.txt")), false, "symlink to a file removed");
      assert.equal(existsSync(join(workspace, "hostsdir")), false, "symlink to a directory removed");
      return { data: { summary: "s", findings: [] }, error: null, dropped: [] };
    },
  });
  assert.equal(code, 0);
  assert.equal(snapshot.startsWith(repo.dir + "/"), false, "snapshot lives outside the checkout");
  assert.equal(existsSync(snapshot), false, "snapshot is removed after the run");
  assert.match(readFileSync(join(outDir, "r.md"), "utf8"), /2 symlink\(s\) removed from analysis snapshot/);
});

test("--out-dir . never deletes repository files", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "app.js"), "export const a = 1;\n");
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "-qm", "src");
  const head = git(repo.dir, "rev-parse", "HEAD");
  const code = await run(["review", "--platform", "none", "--base", repo.base, "--head", head, "--out-dir", "."], {
    env: { PATH: process.env.PATH },
    cwd: repo.dir,
    log: () => {},
    out: () => {},
    analyze: okAnalysis([]),
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(repo.dir, "src", "app.js"), "utf8"), "export const a = 1;\n");
  assert.ok(existsSync(join(repo.dir, "findings.json")), "out-dir honored");
});

test("model text cannot inject CI workflow commands into stdout", async () => {
  const repo = makeRepo();
  const hostile = [
    "::set-output name=y::2",
    "   ::add-mask::secret",
    "\u00a0::set-env name=W::1",
    "note ##vso[task.setvariable variable=z]1",
    "##[group]boom",
    "\u001b[31mred\u001b[0m",
  ].join("\r\n");
  const r = await review(repo, ["--platform", "none"], { analyze: okAnalysis([F({ title: hostile })], hostile) });
  assert.equal(r.code, 0);
  // GitHub parses :: after TrimStart (any .NET whitespace); legacy ##[/##vso[
  // are matched anywhere.
  assert.doesNotMatch(r.outs, /^[^\S\r\n]*::/m);
  assert.doesNotMatch(r.outs, /##vso\[/i);
  assert.doesNotMatch(r.outs, /##\[/);
  assert.doesNotMatch(r.outs, /\r/);
  assert.doesNotMatch(r.outs, /\u001b\[31m/);
  assert.match(r.outs, /\u200b::set-output name=y::2/);
  assert.match(r.outs, /[ \t]+\u200b::add-mask::secret/);
  assert.match(r.outs, /note #\u200b#vso\[task\.setvariable/);
  assert.match(r.outs, /red/);
});

test("safeConsole defuses command tokens that runners scan for anywhere", () => {
  const out = safeConsole(
    "\u001b[1mbold\u001b[0m\r\n  ::set-env name=A::b\nx ##vso[task.complete]y\n##[section]z\n\u0001ctl\u0007",
  );
  assert.doesNotMatch(out, /^[^\S\r\n]*::/m);
  assert.doesNotMatch(out, /##vso\[/i);
  assert.doesNotMatch(out, /##\[/);
  assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(out, /^[ \t]+\u200b::set-env/m);
  assert.equal(safeConsole(undefined), "");
});

test("safeConsole defuses :: behind every whitespace .NET TrimStart strips", () => {
  // Char.IsWhiteSpace covers these; a plain [ \t]* guard would let them through.
  for (const ws of ["\u00a0", "\u1680", "\u2003", "\u202f", "\u3000", "\ufeff", " \t"]) {
    const out = safeConsole(`ok\n${ws}::add-mask::secret`);
    assert.doesNotMatch(out, /^[^\S\r\n]*::/m, `bypass with U+${ws.codePointAt(0).toString(16)}`);
    assert.match(out, /\u200b::add-mask::secret/);
  }
  // NEL is whitespace in .NET but not in JS: it must be stripped, not kept.
  assert.doesNotMatch(safeConsole("a\u0085::set-env name=A::b"), /\u0085/);
  assert.doesNotMatch(safeConsole("a\u0085::set-env name=A::b"), /^[^\S\r\n]*::/m);
});

test("safeConsole strips C1 controls, bidi overrides and TeamCity commands", () => {
  assert.doesNotMatch(safeConsole("a\u009b31m\u009d0"), /[\u0080-\u009f]/);
  assert.doesNotMatch(safeConsole("\u202etxt\u2066x"), /[\u202a-\u202e\u2066-\u2069]/);
  assert.doesNotMatch(safeConsole("x ##TeamCity[buildProblem]"), /##teamcity\[/i);
  // Unterminated OSC must not rescan the rest of the message per ESC.
  const started = Date.now();
  safeConsole("\u001b]".repeat(200_000));
  // Linear is ~ms; a quadratic rescan of 200k ESC] takes minutes. 5 s tolerates loaded runners.
  assert.ok(Date.now() - started < 5000, "no quadratic rescan");
});

test("an unexpected throw exits 2 with sanitized stderr", () => {
  const repo = makeRepo();
  // A file where --out-dir expects a directory: mkdirSync throws, uncaught by run().
  const blocker = join(repo.dir, "x\n::add-mask::secret");
  writeFileSync(blocker, "x\n");
  const res = spawnSync(process.execPath, [
    fileURLToPath(new URL("../bin/cra.js", import.meta.url)),
    "review", "--platform", "none", "--base", repo.base, "--head", repo.head, "--out-dir", blocker,
  ], { cwd: repo.dir, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.doesNotMatch(res.stderr, /^[^\S\r\n]*::/m);
  assert.match(res.stderr, /\u200b::add-mask::secret/);
});

/** Local "origin": feature, plus/foo+bar and user@fix each at a different commit. */
function makeOrigin() {
  const origin = mkdtempSync(join(tmpdir(), "cra-origin-"));
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "a.js"), "a\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "c1");
  git(origin, "checkout", "-qb", "feature");
  writeFileSync(join(origin, "f.js"), "f\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "feature");
  const featureSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-qb", "plus/foo+bar");
  writeFileSync(join(origin, "plus.js"), "plus\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "plus");
  const plusSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-qb", "user@fix");
  writeFileSync(join(origin, "user.js"), "user\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "user");
  const userSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  writeFileSync(join(origin, "b.js"), "b\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "main tip");
  return { origin, featureSha, plusSha, userSha };
}

function shallowClone(origin) {
  const work = join(mkdtempSync(join(tmpdir(), "cra-work-")), "repo");
  git(tmpdir(), "clone", "-q", "--depth", "1", `file://${origin}`, work);
  return work;
}

test("a ref can never reach git fetch as an option", async (t) => {
  const { origin } = makeOrigin();
  const work = shallowClone(origin);
  const canaryDir = mkdtempSync(join(tmpdir(), "cra-canary-"));
  t.after(() => {
    for (const p of [origin, work, canaryDir]) rmSync(p, { recursive: true, force: true });
  });
  const marker = join(canaryDir, "pwned");
  const canary = join(canaryDir, "canary.sh");
  writeFileSync(canary, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(canary, 0o755);

  const logs = [];
  assert.throws(
    () => ensureCommits([`origin/--upload-pack=${canary}`], work, (m) => logs.push(m)),
    /not a plain ref name/,
  );
  // Validation runs before any git call: option-like and refspec-like input never reaches argv.
  for (const bad of ["--path=/tmp/x", "origin/main:refs/heads/main", "origin/+main", "origin/a b"]) {
    assert.throws(() => ensureCommits([bad], work, (m) => logs.push(m)), /not a plain ref name/, bad);
  }
  assert.equal(existsSync(marker), false, "upload-pack helper never ran");
  assert.doesNotMatch(logs.join("\n"), /fetching/, "git was never called");

  // The same ref through the CLI exits 2 without running the helper.
  const cliLogs = [];
  const code = await run(["review", "--platform", "none", "--base", `origin/--upload-pack=${canary}`, "--out-dir",
    mkdtempSync(join(tmpdir(), "cra-out-"))], {
    env: { PATH: process.env.PATH }, cwd: work, log: (m) => cliLogs.push(m), out: () => {},
  });
  assert.equal(code, 2);
  assert.equal(existsSync(marker), false);
  assert.match(cliLogs.join("\n"), /not a plain ref name/);
});

test("fetching origin/HEAD never dereferences its symref", (t) => {
  const { origin } = makeOrigin();
  const work = shallowClone(origin);
  t.after(() => {
    for (const p of [origin, work]) rmSync(p, { recursive: true, force: true });
  });
  // A dangling symref makes origin/HEAD unresolvable, so it gets fetched.
  git(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/ghost");
  const mainSha = git(work, "rev-parse", "refs/remotes/origin/main");
  ensureCommits(["origin/HEAD"], work, () => {});
  assert.equal(git(work, "rev-parse", "--verify", "refs/remotes/origin/HEAD"), mainSha, "ref resolves");
  assert.throws(() => git(work, "rev-parse", "--verify", "refs/remotes/origin/ghost"),
    "the symref target was not created");
  assert.equal(git(work, "rev-parse", "refs/remotes/origin/main"), mainSha);
});

test("ensureCommits still fetches legitimate refs through --", (t) => {
  const { origin, featureSha, plusSha, userSha } = makeOrigin();
  const work = shallowClone(origin);
  t.after(() => {
    for (const p of [origin, work]) rmSync(p, { recursive: true, force: true });
  });
  // Distinct tips: a skipped or misdirected fetch leaves the old FETCH_HEAD and fails.
  assert.equal(new Set([featureSha, plusSha, userSha]).size, 3, "fixture branches differ");
  const cases = [["origin/feature", featureSha], ["origin/plus/foo+bar", plusSha], ["origin/user@fix", userSha]];
  for (const [name, sha] of cases) {
    const logs = [];
    ensureCommits([name], work, (m) => logs.push(m));
    assert.match(logs.join("\n"), /fetching /);
    // The ref the caller asked for must now resolve to its own tip; FETCH_HEAD alone
    // would leave `--base origin/<branch>` unresolvable and the diff would fail.
    assert.equal(git(work, "rev-parse", "--verify", `${name}^{commit}`), sha, `${name} resolves after the fetch`);
    assert.equal(git(work, "rev-parse", "FETCH_HEAD"), sha, `${name} fetched its own tip`);
  }
});
