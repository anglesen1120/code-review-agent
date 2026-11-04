import { createHash } from "node:crypto";
import { codeSpan, inlineText, normalizeTitle, sanitize } from "./lifecycle.js";

const SEVERITIES = ["Critical", "Warning", "Info"];
const SARIF_LEVEL = { Critical: "error", Warning: "warning", Info: "note" };
const CODEQUALITY_LEVEL = { Critical: "critical", Warning: "major", Info: "info" };
const TOOL_NAME = "code-review-agent";
const TOOL_URL = "https://github.com/anglesen1120/code-review-agent";
const CATEGORY_LABEL = {
  security: "Security", bug: "Bug", performance: "Performance", design: "Design",
  test: "Tests", style: "Style", maintainability: "Maintainability",
  dependency: "Dependency", docs: "Docs", other: "Other",
};

const categoryId = (f) => `cra/${f.category}`;
const messageFor = (f) => (f.description ? `${f.title}\n\n${f.description}` : f.title);
// SARIF regions must satisfy 1 <= startLine <= endLine even when a finding
// supplies a (validation-permitted) endLine above a startLine fallback.
const startOf = (f) => Math.max(1, f.startLine ?? f.line);
const endOf = (f) => Math.max(startOf(f), f.endLine ?? startOf(f));

// artifactLocation.uri is a URI: '#' would start a fragment, so encode each
// path segment and keep '/' as the separator.
const artifactUri = (file) => String(file).split("/").map(encodeURIComponent).join("/");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Stable identity of a finding location: unaffected by line drift or reruns. */
export function sarifFingerprint(f) {
  return sha256(`${f.file}:${normalizeTitle(f.title)}`);
}

export function codeQualityFingerprint(f) {
  return sha256(`${f.file}:${f.line}:${normalizeTitle(f.title)}`);
}

export function toSarif(findings, { toolVersion = "0.0.0" } = {}) {
  const categories = [...new Set(findings.map((f) => f.category))].sort();
  const rules = categories.map((category) => ({
    id: `cra/${category}`,
    name: `cra/${category}`,
    shortDescription: { text: CATEGORY_LABEL[category] ?? category },
  }));
  const ruleIndex = new Map(categories.map((category, i) => [category, i]));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            informationUri: TOOL_URL,
            version: toolVersion,
            rules,
          },
        },
        results: findings.map((f) => ({
          ruleId: categoryId(f),
          ruleIndex: ruleIndex.get(f.category),
          level: SARIF_LEVEL[f.severity] ?? "note",
          message: { text: messageFor(f) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: artifactUri(f.file) },
                region: { startLine: startOf(f), endLine: endOf(f) },
              },
            },
          ],
          partialFingerprints: { primaryLocationLineHash: sarifFingerprint(f) },
        })),
      },
    ],
  };
}

export function toCodeQuality(findings) {
  return findings.map((f) => ({
    description: messageFor(f),
    check_name: categoryId(f),
    fingerprint: codeQualityFingerprint(f),
    severity: CODEQUALITY_LEVEL[f.severity] ?? "info",
    location: { path: f.file, lines: { begin: f.line } },
  }));
}

export function toMarkdownReport({ summary, findings = [], notes = [] }) {
  const groups = { Critical: [], Warning: [], Info: [] };
  for (const f of findings) groups[f.severity]?.push(f);
  const counts = SEVERITIES.map((s) => groups[s].length);
  const lines = ["## Code Review Report", ""];
  if (summary) lines.push(sanitize(summary), "");
  lines.push(
    `**Critical: ${counts[0]} · Warning: ${counts[1]} · Info: ${counts[2]} · Total: ${findings.length}**`,
  );
  if (findings.length === 0) lines.push("", "No findings.");
  for (const severity of SEVERITIES) {
    const group = groups[severity];
    if (group.length === 0) continue;
    lines.push("", `### ${severity} (${group.length})`);
    group.forEach((f, i) => {
      lines.push(
        "",
        `#### ${i + 1}. ${codeSpan(`${f.file}:${f.line}`)} — ${inlineText(f.title)}`,
        "",
        `**${inlineText(f.category)}**`,
        "",
        sanitize(f.description),
      );
      if (f.suggestion) lines.push("", "**Suggestion:**", "", sanitize(f.suggestion));
    });
  }
  if (notes.length > 0) {
    lines.push("", "### Notes", "");
    for (const note of notes) lines.push(`- ${sanitize(note)}`);
  }
  lines.push("");
  return lines.join("\n");
}
