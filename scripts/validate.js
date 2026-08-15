// Minimal validator for schema/findings.schema.json. Zero dependencies.
// Used by analyze.sh, post-review.js, and tests as the single enforcement point
// for structured analyzer output.

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
const MAX_FINDINGS = 20;

const isInt = (v) => Number.isInteger(v);
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

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
