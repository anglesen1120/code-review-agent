import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Keep the original action's exclusions for every CI entry point.
export const DEFAULT_EXCLUDES = Object.freeze([
  "*.lock", "*.min.js", "*.min.css", "*.map",
  "yarn.lock", "pnpm-lock.yaml", "package-lock.json",
  "**/dist/**", "**/obj/**", "**/bin/**", "**/node_modules/**",
]);

// Git quotes unusual path bytes using C escapes, including UTF-8 octal bytes.
function decodePath(value) {
  if (!value.startsWith('"')) return value.split("\t", 1)[0];
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 1; i < value.length && value[i] !== '"'; i++) {
    if (value[i] !== "\\") {
      const cp = value.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(cp)));
      if (cp > 0xffff) i++;
      continue;
    }
    const next = value[++i];
    if (/[0-7]/.test(next ?? "")) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(value[i + 1] ?? "")) octal += value[++i];
      bytes.push(parseInt(octal, 8));
    } else if (next !== undefined) {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const headerPath = (value) => {
  const path = decodePath(value);
  return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
};

// `diff --git` does NOT quote paths with spaces, so `a/foo b/bar b/foo b/bar`
// must be split structurally: prefer the split where both sides are identical
// (modify / mode / binary), else the first valid `a/... b/...` split (rename).
function gitHeaderPaths(names) {
  if (names.startsWith('"')) {
    const quoted = names.match(/^"(?:\\.|[^"\\])*"/);
    return quoted
      ? { oldPath: headerPath(quoted[0]), path: headerPath(names.slice(quoted[0].length).trimStart()) }
      : { oldPath: null, path: null };
  }
  if (names.startsWith("a/")) {
    let fallback = null;
    for (let i = 2; i < names.length; i++) {
      if (names[i] !== " " || !names.startsWith("b/", i + 1)) continue;
      const left = headerPath(names.slice(2, i));
      const right = headerPath(names.slice(i + 3));
      if (left === right) return { oldPath: left, path: right };
      fallback ??= { oldPath: left, path: right };
    }
    if (fallback) return fallback;
  }
  // Hand-written header without git's a/ and b/ prefixes.
  const space = names.indexOf(" ");
  return space > 0
    ? { oldPath: headerPath(names.slice(0, space)), path: headerPath(names.slice(space + 1)) }
    : { oldPath: headerPath(names), path: headerPath(names) };
}

function filePaths(text) {
  let oldPath = null;
  let path = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@ ")) break;
    if (line.startsWith("diff --git ")) {
      ({ oldPath, path } = gitHeaderPaths(line.slice(11)));
    } else if (line.startsWith("rename from ")) oldPath = decodePath(line.slice(12));
    else if (line.startsWith("rename to ")) path = decodePath(line.slice(10));
    else if (line.startsWith("--- ")) oldPath = headerPath(line.slice(4));
    else if (line.startsWith("+++ ")) path = headerPath(line.slice(4));
  }
  return { path, oldPath };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split without changing bytes; include metadata-only renames and binary files.
 * Diffs produced by git always carry `diff --git`; a hand-written unified diff
 * has no such marker, so `--- `/`+++ ` pairs start sections — but only OUTSIDE
 * a hunk, because hunk payload may itself contain removed `--- x` / added
 * `+++ y` lines.
 */
export function splitDiffByFile(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const gitHeaders = /^diff --git /m.test(text);
  const starts = [];
  let oldRemaining = 0;
  let newRemaining = 0;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    if (line.startsWith("diff --git ")) {
      starts.push(offset);
      oldRemaining = 0;
      newRemaining = 0;
    } else if (inHunk) {
      if (line[0] === " " || line[0] === "+") newRemaining--;
      if (line[0] === " " || line[0] === "-") oldRemaining--;
    } else {
      const hunk = HUNK_RE.exec(line);
      if (hunk) {
        if (!starts.length) starts.push(0);
        oldRemaining = Number(hunk[2] ?? 1);
        newRemaining = Number(hunk[4] ?? 1);
      } else if (!gitHeaders && line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
        starts.push(offset);
      }
    }
    offset += line.length + 1;
  }
  return starts.map((start, i) => {
    const section = text.slice(i === 0 ? 0 : start, starts[i + 1] ?? text.length);
    const { path, oldPath } = filePaths(section);
    return { path: path ?? oldPath, text: section };
  });
}

/** Map only new-side lines that are actually present in a unified-diff hunk. */
export function parseUnifiedDiff(text) {
  const index = new Map();
  for (const section of splitDiffByFile(text)) {
    const { path, oldPath } = filePaths(section.text);
    if (path === null) continue;
    const anchors = new Map();
    let oldLine = 0;
    let newLine = 0;
    let oldRemaining = 0;
    let newRemaining = 0;
    for (const line of section.text.split("\n")) {
      const hunk = HUNK_RE.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        oldRemaining = Number(hunk[2] ?? 1);
        newLine = Number(hunk[3]);
        newRemaining = Number(hunk[4] ?? 1);
        continue;
      }
      if (!oldRemaining && !newRemaining) continue;
      const type = line[0];
      if (type === " " || type === "+") {
        const anchor = { type: type === "+" ? "add" : "context", oldLine: type === "+" ? null : oldLine };
        if (oldPath !== null && oldPath !== path) anchor.oldPath = oldPath;
        anchors.set(newLine++, anchor);
        newRemaining--;
      }
      if (type === " " || type === "-") {
        oldLine++;
        oldRemaining--;
      }
    }
    if (anchors.size) index.set(path, anchors);
  }
  return index;
}

/** Keep a prefix of complete files, never truncating a hunk or skipping ahead. */
export function capDiff(text, maxBytes) {
  if (!(maxBytes >= 0)) throw new RangeError("maxBytes must be non-negative");
  const kept = [];
  const skipped = [];
  let bytes = 0;
  let full = false;
  for (const section of splitDiffByFile(text)) {
    const size = Buffer.byteLength(section.text, "utf8");
    if (full || bytes + size > maxBytes) {
      full = true;
      skipped.push(section.path ?? "(unknown)");
    } else {
      kept.push(section.text);
      bytes += size;
    }
  }
  return { text: kept.join(""), skipped };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

// execFileSync prevents shell injection but not OPTION injection: a revision
// starting with "-" would be parsed as a git flag (`--output=<file>`). Exported
// so the CLI rejects bad revisions before any git command runs (fetch included).
export function assertRevision(name, value) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} revision is required`);
  if (value.startsWith("-") || /[\s\0]/.test(value)) {
    throw new TypeError(`${name} is not a valid git revision: ${value}`);
  }
}

// Repositories may set diff.noprefix/diff.mnemonicPrefix; the parser relies on
// the canonical a/ b/ prefixes, so pin them for every diff we produce.
const PREFIX_OPTS = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];

// `--text`: a PR can commit `.gitattributes` (`* -diff` / `binary`) and turn the
// whole diff into "Binary files … differ", blinding the review without any
// prompt injection. `--no-ext-diff`/`--no-textconv` keep configured drivers out
// of the output. The byte budget (capDiff) still bounds binary payloads.
const DIFF_OPTS = ["--no-color", "-U5", "--text", "--no-ext-diff", "--no-textconv"];

const pathspec = (pattern) => (
  // Git pathspecs do not match root-level `dist/x` with `**/dist/**`, so emit
  // the root-anchored variant too; the intent of the action's list is "anywhere".
  pattern.startsWith("**/")
    ? [`:(exclude)${pattern}`, `:(exclude)${pattern.slice(3)}`]
    : [`:(exclude)${pattern}`]
);

const excludedPaths = (excludes) => {
  const extra = typeof excludes === "string" ? excludes.split(",") : excludes;
  return [...DEFAULT_EXCLUDES, ...extra.map((p) => p.trim()).filter(Boolean)].flatMap(pathspec);
};

export function gitDiff({ base, head, excludes = [], cwd } = {}) {
  assertRevision("base", base);
  assertRevision("head", head);
  const scope = [`${base}...${head}`, "--", ".", ...excludedPaths(excludes)];
  const diff = git([...PREFIX_OPTS, "diff", ...DIFF_OPTS, ...scope], cwd);
  const changedFiles = git([...PREFIX_OPTS, "diff", "--name-only", "-z", ...scope], cwd).split("\0").filter(Boolean);
  return { diff, changedFiles };
}

/**
 * Same exclusions as gitDiff for `cra analyze` without --base: tracked local
 * changes against HEAD (untracked files are not reviewed).
 */
export function workingTreeDiff({ cwd, excludes = [] } = {}) {
  const scope = ["HEAD", "--", ".", ...excludedPaths(excludes)];
  return {
    diff: git([...PREFIX_OPTS, "diff", ...DIFF_OPTS, ...scope], cwd),
    changedFiles: git([...PREFIX_OPTS, "diff", "--name-only", "-z", ...scope], cwd).split("\0").filter(Boolean),
  };
}

export function changedFilesBetween({ from, to, cwd } = {}) {
  assertRevision("from", from);
  assertRevision("to", to);
  try {
    git(["rev-parse", "--verify", "--quiet", `${from}^{commit}`], cwd);
  } catch (error) {
    // Status 1 = the revision is gone (force-push); anything else (not a
    // repository, unreadable object database) must surface, not look like "no changes".
    if (error.status === 1) return null;
    throw error;
  }
  return git(["diff", "--name-only", "-z", from, to, "--"], cwd).split("\0").filter(Boolean);
}

/**
 * Export the tracked tree at `rev` into `dest` (no .git history, no untracked
 * files) and remove every symlink so the model cannot read outside the
 * snapshot. `dest` must be an empty/absent directory, and `git init` gives the
 * snapshot its own empty repository: the analyzer's workspace resolves to the
 * snapshot, never to the checkout's .git (which holds the remote URL + token).
 * @returns {{dir: string, symlinksRemoved: number}}
 */
export function snapshotTree({ rev, cwd, dest } = {}) {
  assertRevision("rev", rev);
  if (typeof dest !== "string" || !dest) throw new TypeError("snapshot destination is required");
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) throw new Error(`snapshot destination is not a directory: ${dest}`);
    if (readdirSync(dest).length > 0) throw new Error(`snapshot destination is not empty: ${dest}`);
  } else {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
  }
  const tarPath = `${dest}.tar`;
  try {
    git(["archive", "--format=tar", "-o", tarPath, rev], cwd);
    execFileSync("tar", ["-xf", tarPath, "-C", dest], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    rmSync(tarPath, { force: true });
  }
  const symlinksRemoved = removeSymlinks(dest);
  // An archive entry named `.git` would make `git init` reuse attacker-supplied
  // config (core.fsmonitor, core.sshCommand, hooks). Git blocks such paths on
  // push, but other hosts are not guaranteed to; never trust the tree.
  for (const entry of readdirSync(dest)) {
    if (entry.toLowerCase() === ".git") rmSync(join(dest, entry), { recursive: true, force: true });
  }
  execFileSync("git", ["init", "-q"], { cwd: dest, stdio: ["ignore", "ignore", "pipe"] });
  return { dir: dest, symlinksRemoved };
}

function removeSymlinks(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      unlinkSync(path);
      removed++;
    } else if (entry.isDirectory()) {
      removed += removeSymlinks(path);
    }
  }
  return removed;
}
