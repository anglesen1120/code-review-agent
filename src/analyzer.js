// Analyzer: run the opencode agent headlessly to turn a PR diff into
// schema-valid findings. The only stage that calls an LLM. Never writes to the
// repo and never throws for model/provider failures — it returns `error`, and
// the caller decides (a failed analysis must never resolve threads).
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeFindings, validateFindings } from "./validate.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MODEL = "go/deepseek-v4.1-flash";
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const KEY_ENV = "CRA_API_KEY";

/** "provider/model" → parts; a bare model name gets the "cra" provider. */
export function splitModel(model) {
  const slash = model.indexOf("/");
  return slash === -1
    ? { providerName: "cra", modelName: model }
    : { providerName: model.slice(0, slash), modelName: model.slice(slash + 1) };
}

/**
 * opencode.json for the read-only `code-reviewer` agent. Deny-by-default:
 * the agent may only read/search the repo and the scratch dir. No shell, no
 * edits, no network tools — the diff is attacker-controlled (prompt
 * injection), so there must be no exfiltration channel and no secret reads.
 */
export function buildOpencodeConfig({ baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, prompt = "", scratchDir }) {
  const { providerName, modelName } = splitModel(model);
  const scratch = scratchDir.replace(/\/+$/, "");
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerName]: {
        npm: "@ai-sdk/openai-compatible",
        name: providerName,
        options: { baseURL: baseUrl, apiKey: `{env:${KEY_ENV}}` },
        models: { [modelName]: { name: modelName } },
      },
    },
    agent: {
      "code-reviewer": {
        description: "Reviews PR diffs for bugs, security, and quality. Read-only.",
        mode: "primary",
        model: `${providerName}/${modelName}`,
        permission: {
          "*": "deny",
          read: {
            "*": "allow",
            "*.env": "deny",
            "*.env.*": "deny",
            "*.env.example": "allow",
            // Patterns match the path as opencode sees it: repo-relative
            // (".git/config") or absolute ("/w/r/.git/config"). The checkout's
            // .git/config may hold the CI token (persist-credentials).
            ".git": "deny",
            ".git/*": "deny",
            "*/.git": "deny",
            "*/.git/*": "deny",
            "*.pem": "deny",
            "*id_rsa*": "deny",
            "*.p12": "deny",
          },
          glob: "allow",
          grep: "allow",
          lsp: "allow",
          todowrite: "allow",
          edit: "deny",
          bash: "deny",
          webfetch: "deny",
          websearch: "deny",
          task: "deny",
          skill: "deny",
          question: "deny",
          doom_loop: "deny",
          // Only the scratch dir (diff + existing_threads.json) is readable
          // outside the repo; /proc, $HOME, runner credentials stay closed.
          external_directory: { "*": "deny", [`${scratch}/*`]: "allow" },
        },
        prompt,
      },
    },
  };
}

// Brace-balanced JSON object spans, string/escape aware.
function* objectSpans(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        yield text.slice(start, i + 1);
        break;
      }
    }
  }
}

/**
 * Extract the findings object from `opencode run --format json` output.
 * Tries, in order: whole text, each fenced block, each balanced `{…}` span;
 * the first candidate that parses and passes validation (after normalization)
 * wins. Robust to prose around the JSON and to ``` inside suggestions.
 * @returns {{ data: object|null, errors: string[], dropped: string[], apiError: {message: string, retryable: boolean}|null }}
 */
export function extractFindings(eventsText, { workspace } = {}) {
  const parts = [];
  let apiError = null;
  for (const line of eventsText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "text" && typeof ev.part?.text === "string") parts.push(ev.part.text);
      if (ev.type === "error") {
        const d = ev.error?.data ?? {};
        apiError = {
          message: [d.statusCode, d.message ?? ev.error?.name ?? "unknown provider error"].filter(Boolean).join(" "),
          retryable: d.isRetryable !== false,
        };
      }
    } catch {
      // non-JSON log line
    }
  }
  const raw = parts.join("\n");
  const candidates = [raw.trim()];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  let lastErrors = ["no JSON object found in model output"];
  const tryCandidate = (c) => {
    let parsed;
    try {
      parsed = JSON.parse(c);
    } catch {
      return null;
    }
    const { data, dropped } = normalizeFindings(parsed, { workspace });
    const v = validateFindings(data);
    if (v.ok) return { data, errors: [], dropped };
    lastErrors = v.errors;
    return null;
  };
  for (const c of candidates) {
    const r = tryCandidate(c);
    if (r) return r;
  }
  for (const span of objectSpans(raw)) {
    if (!span.includes('"findings"')) continue;
    const r = tryCandidate(span);
    if (r) return r;
  }
  return { data: null, errors: lastErrors, dropped: [], apiError };
}

// Environment passed to opencode: an allow-list, never the CI tokens.
const ENV_ALLOW = /^(PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_\w+|TZ|XDG_\w+|SSL_CERT_\w+|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|OPENCODE_\w+|SYSTEMROOT|APPDATA|LOCALAPPDATA|USERPROFILE)$/;

export function childEnv(env, apiKey, configPath) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (ENV_ALLOW.test(k) && v !== undefined) out[k] = v;
  out[KEY_ENV] = apiKey;
  out.OPENCODE_CONFIG = configPath;
  // Ignore consumer-repo opencode.json + AGENTS.md: they must not steer us.
  out.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  return out;
}

function runOnce({ bin, args, cwd, env, eventsPath, errPath, timeoutMs }) {
  return new Promise((resolve) => {
    const out = createWriteStream(eventsPath);
    const err = createWriteStream(errPath);
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, error: e.message });
      return;
    }
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, error: e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const done = () => resolve({ code, error: signal ? `opencode killed by ${signal} (timeout ${timeoutMs} ms)` : null });
      let pending = 2;
      const fin = () => --pending === 0 && done();
      out.end(fin);
      err.end(fin);
    });
  });
}

function tail(path, n) {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

/**
 * @returns {Promise<{data: object|null, error: string|null, dropped: string[]}>}
 */
export async function runAnalysis({
  scratchDir,
  diffPath,
  workspace,
  prNumber,
  baseSha,
  headSha,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  env = process.env,
  opencodeBin = env.CRA_OPENCODE_BIN || "opencode",
  timeoutMs = Number(env.CRA_ANALYZE_TIMEOUT_MS) || 15 * 60 * 1000,
  log = console.error,
}) {
  if (!apiKey) {
    return { data: null, error: "API key not configured (set CRA_API_KEY).", dropped: [] };
  }
  const configPath = join(scratchDir, "opencode.json");
  const prompt = readFileSync(join(ROOT, "prompts", "reviewer-system.md"), "utf8");
  writeFileSync(configPath, JSON.stringify(buildOpencodeConfig({ baseUrl, model, prompt, scratchDir }), null, 2));

  const task =
    `Review ${prNumber ? `PR #${prNumber}` : "the local change set"} (base=${baseSha}, head=${headSha}). ` +
    `Diff file: ${diffPath} (repo-relative paths). Repo root: ${workspace}. ` +
    `If present, read ${join(scratchDir, "existing_threads.json")} for continuity. ` +
    "Output ONLY the JSON findings object described in your system prompt.";
  const strict = " Output ONLY the JSON object. No markdown fences, no prose, no commentary.";
  const cenv = childEnv(env, apiKey, configPath);

  let lastError = null;
  for (const [i, extra] of [[0, ""], [1, strict]]) {
    const eventsPath = join(scratchDir, i === 0 ? "events.jsonl" : "events.retry.jsonl");
    const errPath = join(scratchDir, "opencode.err");
    const { providerName, modelName } = splitModel(model);
    const args = ["run", "--agent", "code-reviewer", "--format", "json", "--model", `${providerName}/${modelName}`, task + extra];
    const r = await runOnce({ bin: opencodeBin, args, cwd: workspace, env: cenv, eventsPath, errPath, timeoutMs });
    if (r.error && r.code === -1) {
      return { data: null, error: `cannot start ${opencodeBin}: ${r.error}`, dropped: [] };
    }
    const { data, errors, dropped, apiError } = extractFindings(readFileSync(eventsPath, "utf8"), { workspace });
    if (data) return { data, error: null, dropped };
    lastError = r.error ?? (apiError ? `provider error: ${apiError.message}` : errors.join("; "));
    log(`code-review-agent: attempt ${i + 1} produced no valid findings: ${lastError}`);
    const giveUp = i === 1 || (apiError && !apiError.retryable);
    if (giveUp) {
      log("--- opencode stderr (tail) ---\n" + tail(errPath, 25));
      log("--- opencode events (tail) ---\n" + tail(eventsPath, 8));
      break;
    }
  }
  return { data: null, error: `analysis produced invalid findings: ${lastError}`, dropped: [] };
}
