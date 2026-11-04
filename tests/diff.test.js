import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXCLUDES, assertRevision, parseUnifiedDiff, splitDiffByFile, capDiff, gitDiff, changedFilesBetween,
  snapshotTree, workingTreeDiff,
} from "../src/diff.js";

const FIXTURE = [
  "diff --git a/src/app.js b/src/app.js",
  "index 1111111..2222222 100644",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,4 +1,5 @@",
  " line one",
  "-removed line",
  "+added line",
  "+added line two",
  " line four",
  " line five",
  "@@ -20,3 +21,3 @@",
  " context a",
  " context b",
  "-old tail",
  "+new tail",
  "\\ No newline at end of file",
  "diff --git a/src/old-name.js b/src/new-name.js",
  "similarity index 90%",
  "rename from src/old-name.js",
  "rename to src/new-name.js",
  "index 3333333..4444444 100644",
  "--- a/src/old-name.js",
  "+++ b/src/new-name.js",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-before",
  "+after",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+hello",
  "+world",
  "diff --git a/src/gone.js b/src/gone.js",
  "deleted file mode 100644",
  "index 6666666..0000000",
  "--- a/src/gone.js",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-bye",
  "-gone",
  'diff --git "a/docs/a b.txt" "b/docs/a b.txt"',
  "index 7777777..8888888 100644",
  '--- "a/docs/a b.txt"',
  '+++ "b/docs/a b.txt"',
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/img/logo.png b/img/logo.png",
  "index 9999999..aaaaaaa 100644",
  "Binary files a/img/logo.png and b/img/logo.png differ",
  "",
].join("\n");

test("parseUnifiedDiff indexes new-side add and context lines", () => {
  const index = parseUnifiedDiff(FIXTURE);
  const app = index.get("src/app.js");
  assert.deepEqual([...app.keys()], [1, 2, 3, 4, 5, 21, 22, 23]);
  assert.deepEqual(app.get(1), { type: "context", oldLine: 1 });
  assert.deepEqual(app.get(2), { type: "add", oldLine: null });
  assert.deepEqual(app.get(3), { type: "add", oldLine: null });
  // "-removed line" advanced only the old counter: new line 4 is old line 3.
  assert.deepEqual(app.get(4), { type: "context", oldLine: 3 });
  assert.deepEqual(app.get(5), { type: "context", oldLine: 4 });
  // Second hunk restarts both counters from its header.
  assert.deepEqual(app.get(21), { type: "context", oldLine: 20 });
  assert.deepEqual(app.get(23), { type: "add", oldLine: null });
});

test("parseUnifiedDiff handles new, deleted, renamed, quoted and binary files", () => {
  const index = parseUnifiedDiff(FIXTURE);
  assert.deepEqual([...index.keys()], ["src/app.js", "src/new-name.js", "docs/new.md", "docs/a b.txt"]);
  // Deleted file (+++ /dev/null) and binary file (no hunks) contribute no anchors.
  assert.equal(index.has("src/gone.js"), false);
  assert.equal(index.has("src/old-name.js"), false);
  assert.equal(index.has("img/logo.png"), false);
  assert.deepEqual(index.get("docs/new.md").get(1), { type: "add", oldLine: null });
  assert.equal(index.get("docs/new.md").size, 2);
  assert.deepEqual(index.get("docs/a b.txt").get(1), { type: "add", oldLine: null });
});

test("parseUnifiedDiff records oldPath on every anchor of a renamed file", () => {
  const renamed = parseUnifiedDiff(FIXTURE).get("src/new-name.js");
  assert.deepEqual(renamed.get(1), { type: "context", oldLine: 1, oldPath: "src/old-name.js" });
  assert.deepEqual(renamed.get(2), { type: "add", oldLine: null, oldPath: "src/old-name.js" });
});

test("parseUnifiedDiff returns an empty map for empty or hunk-less input", () => {
  assert.equal(parseUnifiedDiff("").size, 0);
  assert.equal(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n").size, 0);
});

test("parseUnifiedDiff decodes C-quoted paths with tabs", () => {
  const text = [
    'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
    '--- "a/tab\\there.txt"',
    '+++ "b/tab\\there.txt"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const index = parseUnifiedDiff(text);
  assert.deepEqual([...index.keys()], ["tab\there.txt"]);
  assert.equal(index.get("tab\there.txt").get(1).type, "add");
});

test("splitDiffByFile keeps every section, including metadata-only files", () => {
  const sections = splitDiffByFile(FIXTURE);
  assert.deepEqual(sections.map((s) => s.path), [
    "src/app.js", "src/new-name.js", "docs/new.md", "src/gone.js", "docs/a b.txt", "img/logo.png",
  ]);
  assert.equal(sections.map((s) => s.text).join(""), FIXTURE);
  assert.deepEqual(splitDiffByFile(""), []);
});

test("capDiff keeps whole file sections in order and lists skipped paths", () => {
  const sections = splitDiffByFile(FIXTURE);
  const budget = Buffer.byteLength(sections[0].text + sections[1].text, "utf8");
  const capped = capDiff(FIXTURE, budget);
  assert.equal(capped.text, sections[0].text + sections[1].text);
  assert.deepEqual(capped.skipped, ["docs/new.md", "src/gone.js", "docs/a b.txt", "img/logo.png"]);
  // A budget one byte short of the second file never truncates it mid-hunk.
  const short = capDiff(FIXTURE, budget - 1);
  assert.equal(short.text, sections[0].text);
  assert.equal(short.skipped[0], "src/new-name.js");
  assert.deepEqual(capDiff(FIXTURE, Infinity), { text: FIXTURE, skipped: [] });
  assert.deepEqual(capDiff("", 10), { text: "", skipped: [] });
  assert.throws(() => capDiff(FIXTURE, -1), RangeError);
});

test("splitDiffByFile does not split on ---/+++ lines inside a hunk", () => {
  const plain = [
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1 +1 @@",
    "--- old",
    "+++ new",
    "",
  ].join("\n");
  const sections = splitDiffByFile(plain);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].path, "x.js");
  assert.equal(sections[0].text, plain);
  const index = parseUnifiedDiff(plain);
  assert.deepEqual([...index.keys()], ["x.js"]);
  assert.deepEqual(index.get("x.js").get(1), { type: "add", oldLine: null });
  assert.deepEqual(capDiff(plain, Buffer.byteLength(plain)), { text: plain, skipped: [] });
});

test("splitDiffByFile splits a multi-file hand-written unified diff at top level only", () => {
  const plain = [
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "--- a/y.js",
    "+++ b/y.js",
    "@@ -5 +5 @@",
    "--- hmm",
    "+now",
    "",
  ].join("\n");
  const sections = splitDiffByFile(plain);
  assert.deepEqual(sections.map((s) => s.path), ["x.js", "y.js"]);
  assert.equal(sections.map((s) => s.text).join(""), plain);
  const index = parseUnifiedDiff(plain);
  assert.deepEqual([...index.keys()], ["x.js", "y.js"]);
  assert.deepEqual([...index.get("x.js").keys()], [1, 2]);
  assert.deepEqual(index.get("x.js").get(1), { type: "context", oldLine: 1 });
  assert.deepEqual(index.get("x.js").get(2), { type: "add", oldLine: null });
  assert.deepEqual(index.get("y.js").get(5), { type: "add", oldLine: null });
  const budget = Buffer.byteLength(sections[0].text, "utf8");
  assert.deepEqual(capDiff(plain, budget), { text: sections[0].text, skipped: ["y.js"] });
});

test("splitDiffByFile keeps git sections intact even when payload mimics headers", () => {
  const text = [
    "diff --git a/z.js b/z.js",
    "--- a/z.js",
    "+++ b/z.js",
    "@@ -1,2 +1,2 @@",
    "--- a/fake",
    "+++ b/fake",
    "",
  ].join("\n");
  const sections = splitDiffByFile(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].path, "z.js");
  assert.deepEqual([...parseUnifiedDiff(text).keys()], ["z.js"]);
});

test("filePaths splits git headers for paths containing spaces without quoting", () => {
  // Real git output for a mode-only change: `diff --git` does NOT quote spaces.
  const text = "diff --git a/foo b/bar b/foo b/bar\nold mode 100644\nnew mode 100755\n";
  const sections = splitDiffByFile(text);
  assert.deepEqual(sections.map((s) => s.path), ["foo b/bar"]);
  assert.deepEqual(capDiff(text, 0), { text: "", skipped: ["foo b/bar"] });
  // Rename with spaces: the two sides differ, so the first valid split wins.
  const renamed = "diff --git a/old name.js b/new name.js\nsimilarity index 100%\nrename from old name.js\nrename to new name.js\n";
  assert.deepEqual(splitDiffByFile(renamed).map((s) => s.path), ["new name.js"]);
});

test("gitDiff pins a/ b/ prefixes even when the repo sets diff.noprefix", (t) => {
  const { dir, first, head, git } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "a"), { recursive: true });
  writeFileSync(join(dir, "a", "real.js"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "third");
  const base = head;
  const tip = git("rev-parse", "HEAD").trim();
  git("config", "diff.noprefix", "true");
  const { diff, changedFiles } = gitDiff({ base, head: tip, cwd: dir });
  assert.deepEqual(changedFiles, ["a/real.js"]);
  assert.match(diff, /^diff --git a\/a\/real\.js b\/a\/real\.js$/m);
  assert.match(diff, /^\+\+\+ b\/a\/real\.js$/m);
  // The parser therefore keys the real repo path, not a truncated one.
  assert.deepEqual([...parseUnifiedDiff(diff).keys()], ["a/real.js"]);
  assert.equal(first.length, 40);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "cra-diff-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "src/keep.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "package-lock.json"), '{"version":1}\n');
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const first = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "src/keep.js"), "export const a = 2;\n");
  writeFileSync(join(dir, "package-lock.json"), '{"version":2}\n');
  writeFileSync(join(dir, "dist/out.js"), "compiled\n");
  git("add", "-A");
  git("commit", "-q", "-m", "second");
  return { dir, first, head: git("rev-parse", "HEAD").trim(), git };
}

test("gitDiff diffs a real repository and honours exclusion patterns", (t) => {
  const { dir, first, head } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { diff, changedFiles } = gitDiff({ base: first, head, cwd: dir });
  assert.deepEqual(changedFiles, ["a.txt", "src/keep.js"]);
  assert.match(diff, /^diff --git a\/a\.txt b\/a\.txt$/m);
  assert.doesNotMatch(diff, /package-lock\.json/);
  assert.doesNotMatch(diff, /dist\/out\.js/);

  const scoped = gitDiff({ base: first, head, excludes: "src/keep.js", cwd: dir });
  assert.deepEqual(scoped.changedFiles, ["a.txt"]);
  assert.doesNotMatch(scoped.diff, /keep\.js/);
  assert.ok(DEFAULT_EXCLUDES.includes("**/node_modules/**"));
});

test("gitDiff throws instead of reporting a clean diff when git fails", (t) => {
  const { dir, head } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => gitDiff({ base: "does-not-exist", head, cwd: dir }));
  assert.throws(() => gitDiff({ head, cwd: dir }), TypeError);
});

test("gitDiff rejects option-like revisions and changedFilesBetween surfaces repo errors", (t) => {
  const { dir, first, head } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => gitDiff({ base: "--output=/tmp/cra-review", head, cwd: dir }), TypeError);
  assert.throws(() => gitDiff({ base: first, head: " HEAD", cwd: dir }), TypeError);
  assert.throws(() => changedFilesBetween({ from: "-x", to: head, cwd: dir }), TypeError);
  // A directory that is not a git repository must throw, not read as "no changes".
  const plain = mkdtempSync(join(tmpdir(), "cra-norepo-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.throws(() => changedFilesBetween({ from: first, to: head, cwd: plain }));
});

test("changedFilesBetween returns names, or null for an unreachable revision", (t) => {
  const { dir, first, head } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(changedFilesBetween({ from: first, to: head, cwd: dir }), ["a.txt", "dist/out.js", "package-lock.json", "src/keep.js"]);
  assert.equal(changedFilesBetween({ from: "0123456789abcdef0123456789abcdef01234567", to: head, cwd: dir }), null);
});

test("workingTreeDiff reviews tracked local changes with the same exclusions", (t) => {
  const { dir, head } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "package-lock.json"), '{"version":3}\n');
  writeFileSync(join(dir, "dist/out.js"), "compiled-again\n");
  const plain = workingTreeDiff({ cwd: dir });
  assert.deepEqual(plain.changedFiles, ["a.txt"]);
  assert.match(plain.diff, /^\+three$/m);
  assert.doesNotMatch(plain.diff, /package-lock/);
  assert.doesNotMatch(plain.diff, /dist\/out\.js/);
  const scoped = workingTreeDiff({ cwd: dir, excludes: ["a.txt"] });
  assert.deepEqual(scoped.changedFiles, []);
  assert.equal(scoped.diff.trim(), "");
  assert.equal(head.length, 40);
});

test("assertRevision rejects option-like and whitespace revisions", () => {
  assert.throws(() => assertRevision("base", "--upload-pack=/tmp/x"), TypeError);
  assert.throws(() => assertRevision("head", "HEAD~1 extra"), TypeError);
  assert.throws(() => assertRevision("head", ""), TypeError);
  assert.doesNotThrow(() => assertRevision("head", "origin/main"));
});

test("snapshotTree removes symlinks and refuses a non-empty destination", (t) => {
  const { dir, git } = repo();
  const outside = mkdtempSync(join(tmpdir(), "cra-outside-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, "secret.txt"), "leak\n");
  mkdirSync(join(outside, "hosts"), { recursive: true });
  writeFileSync(join(outside, "hosts", "passwd"), "leak\n");
  symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
  symlinkSync(join(outside, "hosts"), join(dir, "leakdir"));
  git("add", "-A");
  git("commit", "-q", "-m", "symlinks");
  const rev = git("rev-parse", "HEAD").trim();

  const dest = mkdtempSync(join(tmpdir(), "cra-snap-"));
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  const result = snapshotTree({ rev, cwd: dir, dest });
  assert.deepEqual(result, { dir: dest, symlinksRemoved: 2 });
  assert.equal(existsSync(join(dest, "leak.txt")), false, "symlink to a file is gone");
  assert.equal(existsSync(join(dest, "leakdir")), false, "symlink to a directory is gone");
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "one\ntwo\n");
  assert.ok(existsSync(join(dest, ".git")), "snapshot has its own (empty) repository");
  const symlinks = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(dest);
  assert.deepEqual(symlinks, [], "no symlink survives anywhere in the snapshot");

  writeFileSync(join(dest, "keep.txt"), "x\n");
  assert.throws(() => snapshotTree({ rev, cwd: dir, dest }), /not empty/);
  assert.equal(readFileSync(join(dest, "keep.txt"), "utf8"), "x\n", "a refused destination is not modified");
});
