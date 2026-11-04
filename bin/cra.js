#!/usr/bin/env node
// code-review-agent CLI — one entry point for every CI system.
//
//   cra review   review a PR/MR (GitHub, GitLab) or any diff (other CIs):
//                diff → existing threads → LLM analysis → post/resolve/summary
//                → report files → exit code
//   cra analyze  local review of the current branch / working tree (no platform)
//
// Exit codes: 0 ok · 1 gate failed (--fail-on) or nothing could be delivered ·
// 2 usage/configuration error.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, ROOT, runAnalysis } from "../src/analyzer.js";
import {
  assertRevision, capDiff, changedFilesBetween, gitDiff, parseUnifiedDiff, snapshotTree, workingTreeDiff,
} from "../src/diff.js";
import { computeDelta, gateFails, markdownSummary, matchThread, rank } from "../src/lifecycle.js";
import { createPlatform, inferBaseRef, PLATFORMS } from "../src/platforms/index.js";
import { toCodeQuality, toMarkdownReport, toSarif } from "../src/reporters.js";

const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const FAIL_ON = ["none", "critical", "warning"];

class UsageError extends Error {}

const OPTIONS = {
  platform: { type: "string" },
  base: { type: "string" },
  head: { type: "string" },
  "fail-on": { type: "string" },
  exclude: { type: "string" },
  "max-diff-bytes": { type: "string" },
  sarif: { type: "string" },
  codequality: { type: "string" },
  markdown: { type: "string" },
  json: { type: "string" },
  "set-status": { type: "boolean" },
  "dry-run": { type: "boolean" },
  model: { type: "string" },
  "base-url": { type: "string" },
  "out-dir": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

const USAGE = `usage: cra <review|analyze> [options]

  --platform auto|github|gitlab|none   where to post (default auto; env CRA_PLATFORM)
  --base SHA|REF  --head SHA|REF       diff range (default: from the PR/MR, else origin/<target>...HEAD)
  --fail-on none|critical|warning      exit 1 when such issues remain open (env CRA_FAIL_ON, default none)
  --exclude 'glob,glob'                extra paths to skip (env CRA_EXCLUDE)
  --max-diff-bytes N                   diff budget sent to the model (env CRA_MAX_DIFF_BYTES, default 250000)
  --sarif FILE --codequality FILE --markdown FILE --json FILE   report files
  --set-status                         also set a commit status (env CRA_SET_STATUS=true)
  --dry-run                            analyze + print the plan, write nothing to the platform
  --model provider/model --base-url URL   LLM endpoint (env CRA_MODEL, CRA_BASE_URL); key in CRA_API_KEY
  --out-dir DIR                        scratch + findings.json (env CRA_OUT_DIR)
`;

const truthy = (v) => v === true || v === "true" || v === "1";

export function resolveOptions(argv, env) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const command = positionals[0];
  const pick = (flag, envName, dflt) => values[flag] ?? (env[envName] || undefined) ?? dflt;
  const opts = {
    command,
    help: values.help,
    version: values.version,
    platform: command === "analyze" ? "none" : pick("platform", "CRA_PLATFORM", "auto"),
    base: values.base ?? env.CRA_BASE,
    head: values.head ?? env.CRA_HEAD,
    failOn: pick("fail-on", "CRA_FAIL_ON", "none").toLowerCase(),
    exclude: pick("exclude", "CRA_EXCLUDE", "").split(",").map((s) => s.trim()).filter(Boolean),
    maxDiffBytes: Number(pick("max-diff-bytes", "CRA_MAX_DIFF_BYTES", "250000")),
    sarif: values.sarif,
    codequality: values.codequality,
    markdown: values.markdown,
    json: values.json,
    setStatus: values["set-status"] ?? truthy(env.CRA_SET_STATUS),
    dryRun: values["dry-run"] ?? truthy(env.CRA_DRY_RUN),
    model: pick("model", "CRA_MODEL", DEFAULT_MODEL),
    baseUrl: pick("base-url", "CRA_BASE_URL", DEFAULT_BASE_URL),
    outDir: pick("out-dir", "CRA_OUT_DIR", undefined),
    apiKey: env.CRA_API_KEY || env.DEEPSEEK_API_KEY || "",
  };
  if (opts.help || opts.version) return opts;
  if (!["review", "analyze"].includes(command)) throw new UsageError(`unknown command '${command ?? ""}'`);
  if (!PLATFORMS.includes(opts.platform)) throw new UsageError(`--platform must be one of ${PLATFORMS.join("|")}`);
  if (!FAIL_ON.includes(opts.failOn)) throw new UsageError(`--fail-on must be one of ${FAIL_ON.join("|")}`);
  if (!Number.isInteger(opts.maxDiffBytes) || opts.maxDiffBytes < 1000) {
    throw new UsageError("--max-diff-bytes must be an integer >= 1000");
  }
  return opts;
}

function git(args, cwd) {
  // A working-tree or range diff can exceed Node's 1 MiB default.
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasCommit(ref, cwd) {
  try {
    git(["cat-file", "-e", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

// A fetch argument must not be an option (`-x`) or a refspec (`a:b`, `+a`):
// `git fetch` parses options after the remote and a refspec can write a local
// ref. Everything else stays allowed, including `+`, `@` and Unicode names.
const unsafeFetchRef = (target) => (
  !target || target.startsWith("-") || target.startsWith("+") || /[\s\u0000-\u001f\u007f-\u009f:\\]/.test(target)
);

/** Shallow CI clones (GitLab GIT_DEPTH, checkout fetch-depth 1) may lack the base. */
export function ensureCommits(refs, cwd, log) {
  // Validate first: `hasCommit` also runs git, with `${ref}^{commit}` as argv.
  const targets = refs.map((r) => (r ? r.replace(/^origin\//, "") : r));
  refs.forEach((ref, i) => {
    if (ref && unsafeFetchRef(targets[i])) {
      throw new Error(`cannot fetch '${ref}': not a plain ref name`);
    }
  });
  const missing = refs.filter((r) => r && !hasCommit(r, cwd));
  if (missing.length === 0) return;
  log(`code-review-agent: fetching ${missing.join(", ")}`);
  try {
    for (const ref of missing) {
      const target = ref.replace(/^origin\//, "");
      // `--` ends option parsing: nothing after it can be a git flag.
      git(["fetch", "--no-tags", "--", "origin", target], cwd);
      // `git fetch <remote> <ref>` only writes FETCH_HEAD, so `origin/<ref>`
      // would still be unresolvable and the diff would fail right after this.
      if (ref.startsWith("origin/")) {
        // --no-deref: `origin/HEAD` is a symref, and following it would rewrite
        // refs/remotes/origin/<default branch> instead of the ref we resolved.
        git(["update-ref", "--no-deref", `refs/remotes/origin/${target}`, "FETCH_HEAD"], cwd);
      }
    }
  } catch (e) {
    throw new Error(`cannot fetch ${missing.join(", ")} (use a full clone / fetch-depth: 0): ${e.stderr || e.message}`);
  }
}

function defaultOutDir(env, cwd, command) {
  if (command === "analyze") return join(cwd, ".review");
  if (env.RUNNER_TEMP) return join(env.RUNNER_TEMP, "cra");
  if (env.GITLAB_CI === "true") return join(cwd, ".cra"); // artifacts must live in the project dir
  // Unpredictable 0700 scratch dir: a shared /tmp/cra-<pid> could be pre-created
  // by another local user. The analysis snapshot never lives here (see run()).
  // realpath: opencode compares canonical paths; /tmp is a symlink on macOS.
  return realpathSync(mkdtempSync(join(tmpdir(), "cra-")));
}

const writeOut = (path, content) => writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));

function setGitHubOutput(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  // One key=value per line: a newline inside a value (API-provided review id)
  // would forge an extra output.
  const line = ([k, v]) => `${k}=${String(v ?? "").replace(/[\r\n]+/g, " ")}\n`;
  appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(line).join(""));
}

// Model output and PR text reach stdout/stderr verbatim, and CI runners parse
// those streams for commands. GitHub's ::commands are matched after TrimStart
// (.NET Char.IsWhiteSpace), while GitHub's legacy ##[ and Azure's ##vso[/##
// teamcity[ are matched ANYWHERE in the message (IndexOf), so a line prefix
// alone does not stop them: the token itself must be broken. Strip ANSI, C0/C1
// control characters and bidi overrides first, so no control char can be used
// to re-assemble a token, then defuse every command token.
const ANSI_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// Keeps \n and \t; drops \r, C0, DEL, C1 (incl. NEL) and bidi overrides.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
// Whitespace inside one line as .NET's TrimStart sees it (U+0085 is already
// stripped above; \u2028/\u2029 end a line for the `m` flag, so they stay out).
const LINE_LEADING_SPACE = /^([^\S\r\n\u2028\u2029]*)(?=::)/gm;

export function safeConsole(text) {
  return String(text ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARS, "")
    .replace(LINE_LEADING_SPACE, "$1\u200b") // GitHub: TrimStart + startsWith("::")
    .replace(/#(#(?:vso|teamcity)\[|\[)/gi, "#\u200b$1"); // IndexOf-scanned tokens
}

/**
 * Severities of the items still open after this run. A finding that re-reports
 * an existing thread wins when it is more severe: the gate must reflect the
 * code as reviewed now, not the severity the thread was created with.
 */
function openSeveritiesFrom(openThreads, findings, allThreads) {
  const current = new Map();
  for (const f of findings) {
    if (f.severity !== "Critical" && f.severity !== "Warning") continue;
    const t = matchThread(f, allThreads);
    if (!t) continue;
    if (rank[f.severity] > (rank[current.get(t)] ?? 0)) current.set(t, f.severity);
  }
  return openThreads.map((t) => {
    const previous = t.severity ?? "Warning";
    const now = current.get(t);
    return now && rank[now] > rank[previous] ? now : previous;
  });
}

/**
 * The whole pipeline. Dependencies are injectable for tests.
 * @returns {Promise<number>} exit code
 */
export async function run(argv, { env = process.env, cwd = process.cwd(), log = console.error, out = console.log, analyze = runAnalysis, platformFactory = createPlatform } = {}) {
  // Everything printed may carry model or PR text: neutralize CI command syntax.
  const warn = (message) => log(safeConsole(message));
  const say = (message) => out(safeConsole(message));
  let opts;
  try {
    opts = resolveOptions(argv, env);
  } catch (e) {
    warn(`cra: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    say(USAGE);
    return 0;
  }
  if (opts.version) {
    say(VERSION);
    return 0;
  }

  let platform;
  try {
    platform = platformFactory(opts.platform, { env, log: warn });
  } catch (e) {
    warn(`cra: ${e.message}`);
    return 2;
  }
  const workspace = resolve(platform?.context.workspace || cwd);
  // A user-supplied --out-dir is relative to where `cra` was invoked, not to the
  // platform workspace.
  const outDir = opts.outDir
    ? resolve(cwd, opts.outDir)
    : resolve(defaultOutDir(env, workspace, opts.command));
  mkdirSync(outDir, { recursive: true });

  // ---- 1. diff range ------------------------------------------------------
  let base = opts.base ?? platform?.context.baseSha ?? inferBaseRef(env);
  let head = opts.head ?? platform?.context.headSha ?? "HEAD";
  const workingTree = !base && opts.command === "analyze";
  let diff;
  let changedFiles;
  try {
    // Validate before ANY git call: a revision starting with "-" is argv injection.
    if (base) assertRevision("base", base);
    assertRevision("head", head);
    if (workingTree) {
      base = "HEAD";
      ({ diff, changedFiles } = workingTreeDiff({ cwd: workspace, excludes: opts.exclude }));
      diff += "\n";
      head = "WORKTREE";
    } else {
      if (!base) {
        throw new UsageError("no base revision: pass --base (or CRA_BASE), or run in a PR/MR pipeline");
      }
      ensureCommits([base, head], workspace, warn);
      ({ diff, changedFiles } = gitDiff({ base, head, excludes: opts.exclude, cwd: workspace }));
    }
  } catch (e) {
    warn(`cra: ${e.message}`);
    return 2;
  }
  let headSha;
  try {
    headSha = head === "WORKTREE" ? head : git(["rev-parse", head], workspace);
  } catch (e) {
    warn(`cra: cannot resolve ${head}: ${e.stderr || e.message}`);
    return 2;
  }
  // Threads/statuses must anchor to the commit actually reviewed.
  if (platform) platform.context.headSha = headSha;
  const capped = capDiff(diff, opts.maxDiffBytes);
  const diffPath = join(outDir, "pr.diff");
  writeOut(diffPath, capped.text);
  // Only the budgeted text is reviewed, so only it may anchor a finding.
  const diffIndex = parseUnifiedDiff(capped.text);
  const notes = [];
  const skippedFiles = new Set(capped.skipped);
  const wholeDiffSkipped = skippedFiles.size > 0 && !capped.text.trim();
  if (capped.skipped.length > 0) {
    notes.push(`Diff over ${opts.maxDiffBytes} bytes: not reviewed — ${capped.skipped.join(", ")}`);
  }

  // ---- 2. existing threads -------------------------------------------------
  let threads = [];
  let lastReviewedSha = null;
  // Files the budget skipped were not reviewed, so a change in them is no
  // evidence that their thread is fixed: they never feed resolution.
  let changedSince = changedFiles.filter((p) => !skippedFiles.has(p));
  if (platform) {
    try {
      const state = await platform.fetchState();
      threads = state.threads;
      lastReviewedSha = state.lastReviewedSha ?? null;
      if (lastReviewedSha && lastReviewedSha !== headSha) {
        changedSince = (changedFilesBetween({ from: lastReviewedSha, to: headSha, cwd: workspace }) ?? changedFiles)
          .filter((p) => !skippedFiles.has(p));
      } else if (lastReviewedSha === headSha) {
        changedSince = []; // re-run on the same commit: nothing changed under any thread
      }
    } catch (e) {
      warn(`cra: cannot read existing review threads: ${e.message}`);
      return 1;
    }
    writeOut(
      join(outDir, "existing_threads.json"),
      { threads: threads.map(({ path, line, title, severity, isResolved, isOutdated }) => ({ path, line, title, severity, isResolved, isOutdated })) },
    );
  }

  // ---- 3. analysis ---------------------------------------------------------
  let analysis;
  let snapshotDir = null;
  try {
    if (wholeDiffSkipped) {
      analysis = { data: { summary: `Diff over ${opts.maxDiffBytes} bytes: not reviewed.`, findings: [] }, error: null, dropped: [] };
    } else if (!capped.text.trim()) {
      analysis = { data: { summary: "No code changes to review.", findings: [] }, error: null, dropped: [] };
    } else {
      // Committed revisions: analyze a private export (no .git history, no
      // untracked files, no symlinks), so injected instructions cannot reach
      // credentials in the checkout.
      let analysisRoot = workspace;
      if (!workingTree) {
        try {
          snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), "cra-snap-")));
          const snapshot = snapshotTree({ rev: headSha, cwd: workspace, dest: snapshotDir });
          analysisRoot = snapshot.dir;
          if (snapshot.symlinksRemoved > 0) {
            notes.push(`${snapshot.symlinksRemoved} symlink(s) removed from analysis snapshot`);
          }
        } catch (e) {
          warn(`cra: cannot export ${headSha} for analysis: ${e.message}`);
          return 2;
        }
      }
      analysis = await analyze({
        scratchDir: outDir,
        diffPath,
        workspace: analysisRoot,
        prNumber: platform?.context.prNumber,
        baseSha: base,
        headSha,
        model: opts.model,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        env,
        log: warn,
      });
    }
  } finally {
    // The snapshot is a private copy of the tree; drop it as soon as the model
    // has read it (also when analyze() throws).
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
  }
  const analysisFailed = Boolean(analysis.error);
  const notReviewed = wholeDiffSkipped;
  const data = analysis.data ?? { summary: `Analysis failed: ${analysis.error}`, findings: [] };
  for (const d of analysis.dropped ?? []) notes.push(`Dropped: ${d}`);
  if (analysisFailed) {
    warn(`cra: ${analysis.error}`);
    notes.push("Analysis failed — existing threads were left untouched. See the CI job log.");
  }

  // Inline threads need a line inside a diff hunk; the rest are summary-only.
  const anchored = [];
  const unanchored = [];
  for (const f of data.findings) {
    const anchor = diffIndex.get(f.file)?.get(f.line);
    if (anchor) anchored.push({ finding: f, anchor });
    else unanchored.push(f);
  }
  for (const f of unanchored) {
    if (f.severity !== "Info") notes.push(`Outside the diff (not posted inline): ${f.severity} — ${f.title} (${f.file}:${f.line})`);
  }
  writeOut(join(outDir, "findings.json"), data);

  // ---- 4. platform lifecycle -----------------------------------------------
  let openSeverities;
  let unresolvedCount;
  let reviewId = null;
  let deliveryFailed = false;
  let statusFailed = false;
  // Threads on files the budget skipped were not reviewed: never resolve them.
  const reviewThreads = threads.filter((t) => !skippedFiles.has(t.path));
  if (platform) {
    // A failed analysis (or an entirely over-budget diff) carries no evidence
    // that anything was fixed: never resolve, never post. Old threads keep
    // blocking the merge.
    const noEvidence = analysisFailed || notReviewed;
    const delta = noEvidence
      ? { toPost: [], toResolve: [], kept: threads.filter((t) => !t.isResolved) }
      : computeDelta(anchored.map((a) => a.finding), reviewThreads, changedSince);
    const anchorOf = new Map(anchored.map((a) => [a.finding, a.anchor]));

    if (opts.dryRun) {
      say(JSON.stringify({
        post: delta.toPost.map((f) => `${f.severity} ${f.file}:${f.line} ${f.title}`),
        resolve: delta.toResolve.map((t) => `${t.path}:${t.line} ${t.title}`),
        keep: delta.kept.map((t) => `${t.path}:${t.line} ${t.title}`),
      }, null, 2));
      const plannedResolved = new Set(delta.toResolve.map((t) => t.id));
      const stillOpen = threads.filter((t) => !t.isResolved && !plannedResolved.has(t.id));
      openSeverities = openSeveritiesFrom(stillOpen, data.findings, threads)
        .concat(delta.toPost.map((f) => f.severity), unanchored.map((f) => f.severity));
      unresolvedCount = stillOpen.length + delta.toPost.length;
    } else {
      let posted = [];
      let failed = [];
      if (delta.toPost.length > 0) {
        try {
          ({ posted, failed, reviewId } = await platform.postThreads(delta.toPost.map((f) => ({ finding: f, anchor: anchorOf.get(f) }))));
        } catch (e) {
          failed = delta.toPost.map((f) => ({ finding: f, error: e.message }));
        }
        for (const { finding, error } of failed) {
          warn(`cra: could not post ${finding.file}:${finding.line}: ${error}`);
          notes.push(`Could not post inline: ${finding.severity} — ${finding.title} (${finding.file}:${finding.line})`);
        }
      }
      const resolvedIds = new Set();
      for (const t of delta.toResolve) {
        try {
          await platform.resolveThread(t);
          resolvedIds.add(t.id);
        } catch (e) {
          warn(`cra: could not resolve thread ${t.id}: ${e.message}`);
        }
      }
      if (delta.toResolve.length > resolvedIds.size) {
        notes.push(`${delta.toResolve.length - resolvedIds.size} fixed thread(s) could not be auto-resolved (token permissions?).`);
      }
      // Honest gate: count real outcomes, not the plan, and let the severity of
      // the finding that re-reports a thread (an escalation) win.
      const stillOpen = threads.filter((t) => !t.isResolved && !resolvedIds.has(t.id));
      openSeverities = openSeveritiesFrom(stillOpen, data.findings, threads)
        .concat(posted.map((f) => f.severity), failed.map((x) => x.finding.severity),
          unanchored.map((f) => f.severity));
      unresolvedCount = stillOpen.length + posted.length;
      deliveryFailed = delta.toPost.length > 0 && posted.length === 0;

      // A failed or over-budget run has no new evidence: keep the previous
      // reviewed-sha marker (or none), never advance it.
      const markerSha = noEvidence ? lastReviewedSha : headSha;
      let summary = markdownSummary({
        summary: data.summary,
        findings: data.findings,
        headSha: markerSha ?? headSha,
        prNumber: platform.context.prNumber,
        unresolvedCount,
        fileUrl: (file, line) => platform.fileUrl(file, line),
        notes,
        prLabel: platform.prLabel,
      });
      if (noEvidence && !markerSha) {
        summary = summary.replace(/<!-- code-review-agent:reviewed-sha=[^\n]*? -->\n?/, "");
      }
      try {
        await platform.upsertSummary(summary);
      } catch (e) {
        // Informational; the threads are the merge gate.
        warn(`cra: could not create/update the summary comment (threads unaffected): ${e.message}`);
      }
      if (opts.setStatus) {
        const failing = noEvidence || gateFails(openSeverities, opts.failOn === "none" ? "warning" : opts.failOn);
        const description = analysisFailed
          ? "Analysis failed; previous review threads still apply."
          : notReviewed ? "Diff over budget: not reviewed." : `${unresolvedCount} unresolved review thread(s).`;
        try {
          await platform.setStatus(failing ? "failure" : "success", description);
        } catch (e) {
          warn(`cra: could not set commit status: ${e.message}`);
          statusFailed = true;
        }
      }
      warn(`cra: posted ${posted.length}, resolved ${resolvedIds.size}, unresolved ${unresolvedCount}`);
    }
  } else {
    openSeverities = data.findings.map((f) => f.severity);
    unresolvedCount = data.findings.filter((f) => f.severity !== "Info").length;
  }

  // ---- 5. reports + outputs -------------------------------------------------
  const report = toMarkdownReport({ summary: data.summary, findings: data.findings, notes });
  if (opts.sarif) writeOut(opts.sarif, toSarif(data.findings, { toolVersion: VERSION }));
  if (opts.codequality) writeOut(opts.codequality, toCodeQuality(data.findings));
  if (opts.markdown) writeOut(opts.markdown, report);
  if (opts.json) writeOut(opts.json, data);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, report + "\n");
  const result = {
    platform: platform?.name ?? "none",
    findingsCount: data.findings.length,
    unresolvedCount,
    analysisFailed,
    reviewId,
  };
  writeOut(join(outDir, "result.json"), result);
  setGitHubOutput(env, {
    "findings-count": result.findingsCount,
    "unresolved-count": unresolvedCount,
    "review-id": reviewId ?? "",
    "analysis-failed": analysisFailed,
  });
  if (!platform) say(report);

  if (statusFailed) {
    warn("cra: commit status could not be set.");
    return 1;
  }
  if (deliveryFailed) {
    warn("cra: no review thread could be posted — check the token's write permissions.");
    return 1;
  }
  if (notReviewed) {
    warn("cra: diff exceeds --max-diff-bytes; nothing was reviewed.");
    return 1;
  }
  if (opts.failOn !== "none" && (analysisFailed || gateFails(openSeverities, opts.failOn))) {
    warn(analysisFailed ? "cra: failing closed — analysis failed." : `cra: gate failed (--fail-on ${opts.failOn}).`);
    return 1;
  }
  return 0;
}

// Entry point; realpath so `cra` symlinks (npm bin, Docker image) also run.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (e) {
    // An unexpected throw must not dump raw text (paths, git stderr, model
    // output) onto the runner's log without the command-token defense.
    console.error(safeConsole(e?.stack ?? String(e)));
    process.exitCode = 2;
  }
}
