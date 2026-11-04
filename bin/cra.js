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
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, ROOT, runAnalysis } from "../src/analyzer.js";
import { capDiff, changedFilesBetween, gitDiff, parseUnifiedDiff, snapshotTree } from "../src/diff.js";
import { computeDelta, gateFails, markdownSummary } from "../src/lifecycle.js";
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
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hasCommit(ref, cwd) {
  try {
    git(["cat-file", "-e", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Shallow CI clones (GitLab GIT_DEPTH, checkout fetch-depth 1) may lack the base. */
function ensureCommits(refs, cwd, log) {
  const missing = refs.filter((r) => r && !hasCommit(r, cwd));
  if (missing.length === 0) return;
  log(`code-review-agent: fetching ${missing.join(", ")}`);
  try {
    git(["fetch", "--no-tags", "origin", ...missing.map((r) => r.replace(/^origin\//, ""))], cwd);
  } catch (e) {
    throw new Error(`cannot fetch ${missing.join(", ")} (use a full clone / fetch-depth: 0): ${e.stderr || e.message}`);
  }
}

function defaultOutDir(env, cwd, command) {
  if (command === "analyze") return join(cwd, ".review");
  if (env.RUNNER_TEMP) return join(env.RUNNER_TEMP, "cra");
  if (env.GITLAB_CI === "true") return join(cwd, ".cra"); // artifacts must live in the project dir
  return join(tmpdir(), `cra-${process.pid}`);
}

const writeOut = (path, content) => writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));

function setGitHubOutput(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

/**
 * The whole pipeline. Dependencies are injectable for tests.
 * @returns {Promise<number>} exit code
 */
export async function run(argv, { env = process.env, cwd = process.cwd(), log = console.error, out = console.log, analyze = runAnalysis, platformFactory = createPlatform } = {}) {
  let opts;
  try {
    opts = resolveOptions(argv, env);
  } catch (e) {
    log(`cra: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.version) {
    out(VERSION);
    return 0;
  }

  let platform;
  try {
    platform = platformFactory(opts.platform, { env, log });
  } catch (e) {
    log(`cra: ${e.message}`);
    return 2;
  }
  const workspace = resolve(platform?.context.workspace || cwd);
  const outDir = resolve(opts.outDir ?? defaultOutDir(env, workspace, opts.command));
  mkdirSync(outDir, { recursive: true });

  // ---- 1. diff range ------------------------------------------------------
  let base = opts.base ?? platform?.context.baseSha ?? inferBaseRef(env);
  let head = opts.head ?? platform?.context.headSha ?? "HEAD";
  const workingTree = !base && opts.command === "analyze";
  let diff;
  let changedFiles;
  try {
    if (workingTree) {
      base = "HEAD";
      diff = git(["diff", "--no-color", "-U5", "HEAD", "--"], workspace) + "\n";
      changedFiles = git(["diff", "--name-only", "HEAD", "--"], workspace).split("\n").filter(Boolean);
      head = "WORKTREE";
    } else {
      if (!base) {
        throw new UsageError("no base revision: pass --base (or CRA_BASE), or run in a PR/MR pipeline");
      }
      ensureCommits([base, head], workspace, log);
      ({ diff, changedFiles } = gitDiff({ base, head, excludes: opts.exclude, cwd: workspace }));
    }
  } catch (e) {
    log(`cra: ${e.message}`);
    return 2;
  }
  const headSha = head === "WORKTREE" ? head : git(["rev-parse", head], workspace);
  // Threads/statuses must anchor to the commit actually reviewed.
  if (platform) platform.context.headSha = headSha;
  const capped = capDiff(diff, opts.maxDiffBytes);
  const diffPath = join(outDir, "pr.diff");
  writeOut(diffPath, capped.text);
  const diffIndex = parseUnifiedDiff(diff);
  const notes = [];
  if (capped.skipped.length > 0) {
    notes.push(`Diff over ${opts.maxDiffBytes} bytes: not reviewed — ${capped.skipped.join(", ")}`);
  }

  // ---- 2. existing threads -------------------------------------------------
  let threads = [];
  let changedSince = changedFiles;
  if (platform) {
    try {
      const state = await platform.fetchState();
      threads = state.threads;
      if (state.lastReviewedSha && state.lastReviewedSha !== headSha) {
        changedSince = changedFilesBetween({ from: state.lastReviewedSha, to: headSha, cwd: workspace }) ?? changedFiles;
      } else if (state.lastReviewedSha === headSha) {
        changedSince = []; // re-run on the same commit: nothing changed under any thread
      }
    } catch (e) {
      log(`cra: cannot read existing review threads: ${e.message}`);
      return 1;
    }
    writeOut(
      join(outDir, "existing_threads.json"),
      { threads: threads.map(({ path, line, title, severity, isResolved, isOutdated }) => ({ path, line, title, severity, isResolved, isOutdated })) },
    );
  }

  // ---- 3. analysis ---------------------------------------------------------
  let analysis;
  if (!capped.text.trim()) {
    analysis = { data: { summary: "No code changes to review.", findings: [] }, error: null, dropped: [] };
  } else {
    // Committed revisions: analyze a clean export (no .git, no untracked files),
    // so injected instructions cannot reach credentials in the checkout.
    let analysisRoot = workspace;
    if (!workingTree) {
      try {
        analysisRoot = snapshotTree({ rev: headSha, cwd: workspace, dest: join(outDir, "src") });
      } catch (e) {
        log(`cra: cannot export ${headSha} for analysis: ${e.message}`);
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
      log,
    });
  }
  const analysisFailed = Boolean(analysis.error);
  const data = analysis.data ?? { summary: `Analysis failed: ${analysis.error}`, findings: [] };
  for (const d of analysis.dropped ?? []) notes.push(`Dropped: ${d}`);
  if (analysisFailed) {
    log(`cra: ${analysis.error}`);
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
  if (platform) {
    // A failed analysis carries no evidence that anything was fixed: never
    // resolve, never post. Old threads keep blocking the merge.
    const delta = analysisFailed
      ? { toPost: [], toResolve: [], kept: threads.filter((t) => !t.isResolved) }
      : computeDelta(anchored.map((a) => a.finding), threads, changedSince);
    const anchorOf = new Map(anchored.map((a) => [a.finding, a.anchor]));

    if (opts.dryRun) {
      out(JSON.stringify({
        post: delta.toPost.map((f) => `${f.severity} ${f.file}:${f.line} ${f.title}`),
        resolve: delta.toResolve.map((t) => `${t.path}:${t.line} ${t.title}`),
        keep: delta.kept.map((t) => `${t.path}:${t.line} ${t.title}`),
      }, null, 2));
      openSeverities = [...delta.kept, ...threads.filter((t) => !t.isResolved && !delta.toResolve.includes(t) && !delta.kept.includes(t))]
        .map((t) => t.severity ?? "Warning").concat(delta.toPost.map((f) => f.severity));
      unresolvedCount = openSeverities.length;
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
          log(`cra: could not post ${finding.file}:${finding.line}: ${error}`);
          notes.push(`Could not post inline: ${finding.severity} — ${finding.title} (${finding.file}:${finding.line})`);
        }
      }
      const resolvedIds = new Set();
      for (const t of delta.toResolve) {
        try {
          await platform.resolveThread(t);
          resolvedIds.add(t.id);
        } catch (e) {
          log(`cra: could not resolve thread ${t.id}: ${e.message}`);
        }
      }
      if (delta.toResolve.length > resolvedIds.size) {
        notes.push(`${delta.toResolve.length - resolvedIds.size} fixed thread(s) could not be auto-resolved (token permissions?).`);
      }
      // Honest gate: count real outcomes, not the plan.
      const stillOpen = threads.filter((t) => !t.isResolved && !resolvedIds.has(t.id));
      openSeverities = stillOpen.map((t) => t.severity ?? "Warning")
        .concat(posted.map((f) => f.severity), failed.map((x) => x.finding.severity));
      unresolvedCount = stillOpen.length + posted.length;
      deliveryFailed = delta.toPost.length > 0 && posted.length === 0;

      const summary = markdownSummary({
        summary: data.summary,
        findings: data.findings,
        headSha,
        prNumber: platform.context.prNumber,
        unresolvedCount,
        fileUrl: (file, line) => platform.fileUrl(file, line),
        notes,
        prLabel: platform.prLabel,
      });
      try {
        await platform.upsertSummary(summary);
      } catch (e) {
        // Informational; the threads are the merge gate.
        log(`cra: could not create/update the summary comment (threads unaffected): ${e.message}`);
      }
      if (opts.setStatus) {
        const failing = analysisFailed || gateFails(openSeverities, opts.failOn === "none" ? "warning" : opts.failOn);
        try {
          await platform.setStatus(failing ? "failure" : "success",
            analysisFailed ? "Analysis failed; previous review threads still apply." : `${unresolvedCount} unresolved review thread(s).`);
        } catch (e) {
          log(`cra: could not set commit status: ${e.message}`);
        }
      }
      log(`cra: posted ${posted.length}, resolved ${resolvedIds.size}, unresolved ${unresolvedCount}`);
    }
  } else {
    openSeverities = data.findings.map((f) => f.severity);
    unresolvedCount = data.findings.filter((f) => f.severity !== "Info").length;
  }
  // Unanchored Critical/Warning findings still count for the exit-code gate.
  if (platform) openSeverities = openSeverities.concat(unanchored.map((f) => f.severity));

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
  if (!platform) out(report);

  if (deliveryFailed) {
    log("cra: no review thread could be posted — check the token's write permissions.");
    return 1;
  }
  if (opts.failOn !== "none" && (analysisFailed || gateFails(openSeverities, opts.failOn))) {
    log(analysisFailed ? "cra: failing closed — analysis failed." : `cra: gate failed (--fail-on ${opts.failOn}).`);
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
  process.exitCode = await run(process.argv.slice(2));
}
