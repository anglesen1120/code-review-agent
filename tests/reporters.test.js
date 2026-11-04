import test from "node:test";
import assert from "node:assert/strict";
import { toSarif, toCodeQuality, toMarkdownReport } from "../src/reporters.js";

const findings = [
  {
    severity: "Critical", category: "security", file: "src/auth.js", line: 42,
    title: "SQL injection in getUser", description: "String concatenation builds the query.",
    suggestion: "Use parameterized queries.",
  },
  {
    severity: "Warning", category: "performance", file: "src/list.js", line: 10,
    startLine: 8, endLine: 12, title: "N+1 query in render", description: "Each row queries again.",
    suggestion: "Batch the lookup.",
  },
  {
    severity: "Info", category: "style", file: "src/util.js", line: 3,
    title: "Unused import", description: "`join` is unused.", suggestion: "Remove the import.",
  },
];

test("toSarif produces a well-shaped SARIF 2.1.0 document", () => {
  const sarif = toSarif(findings, { toolVersion: "1.2.3" });
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.$schema, "https://json.schemastore.org/sarif-2.1.0.json");
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, "code-review-agent");
  assert.equal(run.tool.driver.informationUri, "https://github.com/anglesen1120/code-review-agent");
  assert.equal(run.tool.driver.version, "1.2.3");
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ["cra/performance", "cra/security", "cra/style"]);
  assert.equal(run.results.length, 3);

  const [critical, warning, info] = run.results;
  assert.equal(critical.ruleId, "cra/security");
  assert.equal(critical.level, "error");
  assert.equal(critical.message.text, "SQL injection in getUser\n\nString concatenation builds the query.");
  assert.deepEqual(critical.locations[0].physicalLocation.artifactLocation, { uri: "src/auth.js" });
  assert.deepEqual(critical.locations[0].physicalLocation.region, { startLine: 42, endLine: 42 });
  assert.equal(warning.level, "warning");
  assert.deepEqual(warning.locations[0].physicalLocation.region, { startLine: 8, endLine: 12 });
  assert.equal(info.level, "note");
  // ruleIndex must agree with the rules array.
  for (const result of run.results) {
    assert.equal(run.tool.driver.rules[result.ruleIndex].id, result.ruleId);
  }
});

test("toSarif fingerprints are stable across runs and line drift", () => {
  const first = toSarif(findings, { toolVersion: "1.0.0" });
  const second = toSarif(findings, { toolVersion: "9.9.9" });
  const hashes = (doc) => doc.runs[0].results.map((r) => r.partialFingerprints.primaryLocationLineHash);
  assert.deepEqual(hashes(first), hashes(second));
  for (const h of hashes(first)) assert.match(h, /^[0-9a-f]{64}$/);
  // Same file + title, moved lines: SARIF fingerprint is unchanged.
  const moved = findings.map((f) => (f.file === "src/auth.js" ? { ...f, line: 500 } : f));
  const movedHashes = hashes(toSarif(moved));
  assert.equal(movedHashes[0], hashes(first)[0]);
  // Title normalization (case/trailing punctuation) keeps the fingerprint stable.
  const renamed = findings.map((f) => (f.file === "src/auth.js" ? { ...f, title: "SQL Injection in GetUser!" } : f));
  assert.equal(hashes(toSarif(renamed))[0], hashes(first)[0]);
  const other = findings.map((f) => (f.file === "src/auth.js" ? { ...f, title: "Path traversal" } : f));
  assert.notEqual(hashes(toSarif(other))[0], hashes(first)[0]);
});

test("toSarif percent-encodes artifact uris and never emits inverted regions", () => {
  const sarif = toSarif([
    { severity: "Warning", category: "bug", file: "src/a#b c.js", line: 10, endLine: 8, title: "Odd", description: "d", suggestion: "s" },
  ]);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "src/a%23b%20c.js");
  assert.deepEqual(sarif.runs[0].results[0].locations[0].physicalLocation.region, { startLine: 10, endLine: 10 });
  const unicode = toSarif([{ severity: "Info", category: "docs", file: "docs/ü.md", line: 1, title: "t", description: "", suggestion: "" }]);
  assert.equal(unicode.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "docs/%C3%BC.md");
});

test("toSarif defaults the tool version and tolerates empty findings", () => {
  const sarif = toSarif([]);
  assert.equal(sarif.runs[0].tool.driver.version, "0.0.0");
  assert.deepEqual(sarif.runs[0].tool.driver.rules, []);
  assert.deepEqual(sarif.runs[0].results, []);
});

test("toCodeQuality emits GitLab code-quality entries with mapped severities", () => {
  const report = toCodeQuality(findings);
  assert.equal(report.length, 3);
  assert.deepEqual(report.map((e) => e.severity), ["critical", "major", "info"]);
  assert.deepEqual(report.map((e) => e.check_name), ["cra/security", "cra/performance", "cra/style"]);
  assert.deepEqual(report[0].location, { path: "src/auth.js", lines: { begin: 42 } });
  assert.equal(report[0].description, "SQL injection in getUser\n\nString concatenation builds the query.");
  for (const entry of report) assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  // Stable across runs; distinct per file/line/title.
  assert.deepEqual(toCodeQuality(findings), report);
  assert.notEqual(report[0].fingerprint, report[1].fingerprint);
  const shifted = toCodeQuality(findings.map((f) => (f.file === "src/auth.js" ? { ...f, line: 43 } : f)));
  assert.notEqual(shifted[0].fingerprint, report[0].fingerprint);
  assert.deepEqual(toCodeQuality([]), []);
});

test("toMarkdownReport groups by severity with file:line and suggestions", () => {
  const md = toMarkdownReport({ summary: "Overall the change is safe.", findings, notes: ["Diff capped to 200 KB"] });
  assert.match(md, /^## Code Review Report\n/);
  assert.match(md, /Overall the change is safe\./);
  assert.match(md, /\*\*Critical: 1 · Warning: 1 · Info: 1 · Total: 3\*\*/);
  const criticalAt = md.indexOf("### Critical (1)");
  const warningAt = md.indexOf("### Warning (1)");
  const infoAt = md.indexOf("### Info (1)");
  assert.ok(criticalAt > 0 && warningAt > criticalAt && infoAt > warningAt);
  assert.match(md, /`src\/auth\.js:42` — SQL injection in getUser/);
  assert.match(md, /\*\*Suggestion:\*\*\n\nUse parameterized queries\./);
  assert.match(md, /`src\/list\.js:10`/);
  assert.match(md, /- Diff capped to 200 KB/);
  assert.ok(md.endsWith("\n"));
});

test("toMarkdownReport keeps hostile filenames inside the code span", () => {
  const hostile = "src/x`\n\n<!-- code-review-agent -->\n\n`y.js";
  const md = toMarkdownReport({
    summary: "",
    findings: [{ severity: "Info", category: "other", file: hostile, line: 1, title: "t", description: "d", suggestion: "" }],
  });
  assert.doesNotMatch(md, /<!-- code-review-agent -->/);
  const heading = md.split("\n").find((line) => line.startsWith("#### 1."));
  // A two-backtick fence, so the single backticks in the name cannot close it.
  assert.match(heading, /^#### 1\. ``src\/x` &lt;!-- code-review-agent --> `y\.js:1`` — t$/);
});

test("toMarkdownReport handles no findings and neutralizes mentions", () => {
  const empty = toMarkdownReport({ summary: "", findings: [] });
  assert.match(empty, /No findings\./);
  assert.doesNotMatch(empty, /### Critical/);
  const risky = toMarkdownReport({
    summary: "Ping @maintainer",
    findings: [{ ...findings[0], description: "see <!-- marker -->" }],
    notes: [],
  });
  assert.doesNotMatch(risky, /@maintainer/);
  assert.doesNotMatch(risky, /<!-- marker -->/);
});

const quickActionLines = (text) => String(text).split("\n").filter((line) => /^[ \t]*\//.test(line));

test("toMarkdownReport neutralizes GitLab quick actions in every model field", () => {
  const md = toMarkdownReport({
    summary: "Overview\n/approve\n/merge",
    findings: [
      {
        severity: "Critical",
        category: "security",
        file: "src/auth.js",
        line: 42,
        title: "Gate\n/merge bypass",
        description: "The guard is gone.\n/approve",
        suggestion: "Restore it.\n  /close",
      },
    ],
    notes: ["Diff capped\n/approve"],
  });
  assert.deepEqual(quickActionLines(md), []);
  assert.match(md, /\u200b\/approve/);
  assert.match(md, /\u200b\/merge/);
  assert.match(md, /\u200b\/close/);
});
