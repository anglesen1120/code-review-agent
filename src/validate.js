// Minimal validator for schema/findings.schema.json. Zero dependencies.
// Single enforcement point for structured analyzer output (analyzer, CLI,
// tests). `normalizeFindings` runs first and repairs the harmless deviations
// LLMs commonly produce; `validateFindings` then enforces the schema.

const SEVERITIES = new Set(["Critical", "Warning", "Info"]);
const CATEGORIES = new Set([
  "security", "bug", "performance", "design", "test", "style",
  "maintainability", "dependency", "docs", "other",
]);
const FINDING_KEYS = new Set([
  "severity", "category", "file", "line", "startLine", "endLine",
  "title", "description", "suggestion",
]);
const ROOT_KEYS = new Set(["summary", "findings"]);
export const MAX_FINDINGS = 20;

/**
 * Length caps for model-authored fields. Over-long text is truncated with "…"
 * (never rejected): a chatty model must not blow past a platform's comment
 * limit or push an injected payload out of view.
 */
export const CAPS = { summary: 4000, title: 200, description: 4000, suggestion: 4000 };

/** Truncate `text` to at most `max` characters, ending with "…" when cut. */
export function truncateField(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// Control characters (C0/C1) and Unicode line/paragraph separators: a filename
// containing any of them cannot be addressed by a platform API and could splice
// new lines into a rendered comment.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

const isInt = (v) => Number.isInteger(v);
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const SEVERITY_ORDER = { Critical: 0, Warning: 1, Info: 2 };

/**
 * Normalize a repo-relative path emitted by the model: strip leading `./` and
 * an absolute workspace prefix. Returns null for
 * paths that escape the repo (`..`) or stay absolute.
 * @param {string} file
 * @param {string} [workspace] absolute repo root
 */
export function normalizePath(file, workspace) {
  if (typeof file !== "string") return null;
  let p = file.trim().replace(/\\/g, "/");
  if (workspace) {
    const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  p = p.replace(/^(?:\.\/)+/, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:\//.test(p) || p.split("/").includes("..")) return null;
  if (CONTROL_CHARS.test(p)) return null;
  return p;
}

const withCappedFields = (f) => {
  const out = { ...f };
  for (const k of ["title", "description", "suggestion"]) out[k] = truncateField(out[k], CAPS[k]);
  return out;
};

/**
 * Repair common model deviations without inventing data:
 * - normalize file paths; drop findings whose path escapes the repo or carries
 *   control characters/newlines;
 * - truncate over-long text fields to `CAPS` (with "…", never rejecting);
 * - keep at most `max` findings, highest severity first (stable within a tier).
 * Non-object input is returned unchanged so validateFindings reports it.
 * @returns {{ data: unknown, dropped: string[] }}
 */
export function normalizeFindings(data, { workspace, max = MAX_FINDINGS } = {}) {
  const dropped = [];
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.findings)) {
    return { data, dropped };
  }
  const kept = [];
  for (const f of data.findings) {
    if (f && typeof f === "object" && !Array.isArray(f) && typeof f.file === "string") {
      const file = normalizePath(f.file, workspace);
      if (file === null) {
        dropped.push(
          CONTROL_CHARS.test(f.file.trim())
            ? "path contains control characters or newlines"
            : `path outside repository: ${f.file}`,
        );
        continue;
      }
      kept.push({ ...withCappedFields(f), file });
    } else {
      kept.push(f);
    }
  }
  const order = (f) => SEVERITY_ORDER[f?.severity] ?? 3;
  const sorted = kept.map((f, i) => [f, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([f]) => f);
  if (sorted.length > max) dropped.push(`${sorted.length - max} lowest-severity finding(s) over the cap of ${max}`);
  return { data: { ...data, summary: truncateField(data.summary, CAPS.summary), findings: sorted.slice(0, max) }, dropped };
}

/**
 * @param {unknown} data parsed JSON value
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFindings(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["root must be a JSON object"] };
  }
  for (const k of Object.keys(data)) {
    if (!ROOT_KEYS.has(k)) errors.push(`root: unexpected property '${k}'`);
  }
  if (!isNonEmptyString(data.summary)) {
    errors.push("summary: required non-empty string");
  }
  if (!Array.isArray(data.findings)) {
    errors.push("findings: required array");
    return { ok: false, errors };
  }
  if (data.findings.length > MAX_FINDINGS) {
    errors.push(`findings: capped at ${MAX_FINDINGS}`);
  }
  data.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const k of Object.keys(f)) {
      if (!FINDING_KEYS.has(k)) errors.push(`${at}: unexpected property '${k}'`);
    }
    if (!SEVERITIES.has(f.severity)) errors.push(`${at}.severity: must be Critical | Warning | Info`);
    if (!CATEGORIES.has(f.category)) errors.push(`${at}.category: invalid category '${f.category}'`);
    if (!isNonEmptyString(f.file)) errors.push(`${at}.file: required non-empty string`);
    else if (CONTROL_CHARS.test(f.file)) errors.push(`${at}.file: must not contain control characters or newlines`);
    if (!isInt(f.line) || f.line < 1) errors.push(`${at}.line: required positive integer`);
    if (f.startLine !== undefined && (!isInt(f.startLine) || f.startLine < 1)) {
      errors.push(`${at}.startLine: positive integer`);
    }
    if (f.endLine !== undefined && (!isInt(f.endLine) || f.endLine < 1)) {
      errors.push(`${at}.endLine: positive integer`);
    }
    if (f.startLine !== undefined && f.endLine !== undefined && f.endLine < f.startLine) {
      errors.push(`${at}: endLine must be >= startLine`);
    }
    for (const k of ["title", "description", "suggestion"]) {
      if (!isNonEmptyString(f[k])) errors.push(`${at}.${k}: required non-empty string`);
    }
  });
  return { ok: errors.length === 0, errors };
}
