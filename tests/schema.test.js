import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeFindings, normalizePath, validateFindings } from "../src/validate.js";

const sample = JSON.parse(
  readFileSync(new URL("./fixtures/findings.sample.json", import.meta.url), "utf8"),
);

test("valid sample passes", () => {
  assert.equal(validateFindings(sample).ok, true);
});

test("empty findings object is valid", () => {
  assert.equal(validateFindings({ summary: "no issues", findings: [] }).ok, true);
});

test("invalid severity rejected", () => {
  const bad = structuredClone(sample);
  bad.findings[0].severity = "Blocker";
  const r = validateFindings(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("severity")));
});

test("missing required field rejected", () => {
  const bad = structuredClone(sample);
  delete bad.findings[1].line;
  assert.equal(validateFindings(bad).ok, false);
});

test("unexpected property rejected", () => {
  const bad = structuredClone(sample);
  bad.findings[0].extra = true;
  assert.equal(validateFindings(bad).ok, false);
});

test("non-integer line rejected", () => {
  const bad = structuredClone(sample);
  bad.findings[0].line = 42.5;
  assert.equal(validateFindings(bad).ok, false);
});

test("invalid category rejected", () => {
  const bad = structuredClone(sample);
  bad.findings[0].category = "spaghetti";
  assert.equal(validateFindings(bad).ok, false);
});

test("root missing summary rejected", () => {
  const bad = structuredClone(sample);
  delete bad.summary;
  assert.equal(validateFindings(bad).ok, false);
});

test("normalizePath strips ./ and the workspace prefix, rejects escapes", () => {
  assert.equal(normalizePath("./src/a.cs"), "src/a.cs");
  assert.equal(normalizePath("/w/repo/src/a.cs", "/w/repo"), "src/a.cs");
  assert.equal(normalizePath("src\\a.cs"), "src/a.cs");
  assert.equal(normalizePath("../etc/passwd"), null);
  assert.equal(normalizePath("/etc/passwd", "/w/repo"), null);
  assert.equal(normalizePath("C:/x/a.cs"), null);
  assert.equal(normalizePath(""), null);
});

test("normalizeFindings keeps the highest severities when over the cap", () => {
  const mk = (severity, i) => ({ ...sample.findings[0], severity, line: i + 1 });
  const many = [...Array.from({ length: 15 }, (_, i) => mk("Info", i)), ...Array.from({ length: 10 }, (_, i) => mk("Warning", i)), mk("Critical", 99)];
  const { data, dropped } = normalizeFindings({ summary: "s", findings: many });
  assert.equal(data.findings.length, 20);
  assert.equal(data.findings[0].severity, "Critical");
  assert.equal(data.findings.filter((f) => f.severity === "Warning").length, 10);
  assert.equal(data.findings.filter((f) => f.severity === "Info").length, 9);
  assert.match(dropped.join(), /6 lowest-severity/);
  assert.equal(validateFindings(data).ok, true);
});

test("normalizeFindings drops findings whose path escapes the repo", () => {
  const { data, dropped } = normalizeFindings({ summary: "s", findings: [{ ...sample.findings[0], file: "../../x" }] });
  assert.equal(data.findings.length, 0);
  assert.match(dropped[0], /outside repository/);
});

test("normalizeFindings passes non-objects through for validation to reject", () => {
  assert.equal(normalizeFindings(null).data, null);
  assert.equal(validateFindings(normalizeFindings([]).data).ok, false);
});

test("normalizePath rejects control characters and newlines in file names", () => {
  assert.equal(normalizePath("src/a\nb.js"), null);
  assert.equal(normalizePath("src/a\rb.js"), null);
  assert.equal(normalizePath("src/a\u0000b.js"), null);
  assert.equal(normalizePath("src/a\u009fb.js"), null);
  assert.equal(normalizePath("src/a\u2028b.js"), null);
  // Surrounding whitespace is still repaired, not rejected.
  assert.equal(normalizePath("src/a.js\n"), "src/a.js");
});

test("validateFindings rejects a file name containing a newline", () => {
  const bad = structuredClone(sample);
  bad.findings[0].file = "src/a.js\n[/approve](https://evil)";
  const r = validateFindings(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("control characters")));
});

test("normalizeFindings drops findings whose path contains a control character", () => {
  const { data, dropped } = normalizeFindings({
    summary: "s",
    findings: [{ ...sample.findings[0], file: "src/a\nb.js" }],
  });
  assert.equal(data.findings.length, 0);
  assert.match(dropped[0], /control characters or newlines/);
});

test("normalizeFindings truncates over-long fields with an ellipsis", () => {
  const long = "x".repeat(5000);
  const finding = { ...sample.findings[0], title: "T".repeat(500), description: long, suggestion: long };
  const { data } = normalizeFindings({ summary: long, findings: [finding] });
  assert.equal(data.summary.length, 4000);
  assert.ok(data.summary.endsWith("…"));
  assert.equal(data.findings[0].title.length, 200);
  assert.ok(data.findings[0].title.endsWith("…"));
  assert.equal(data.findings[0].description.length, 4000);
  assert.equal(data.findings[0].suggestion.length, 4000);
  assert.ok(data.findings[0].description.endsWith("…"));
  // Truncation is a repair, not a rejection: the result still validates.
  assert.equal(validateFindings(data).ok, true);
});

test("normalizeFindings leaves fields at or under the caps untouched", () => {
  const finding = { ...sample.findings[0], title: "T".repeat(200), description: "d".repeat(4000) };
  const { data } = normalizeFindings({ summary: "s", findings: [finding] });
  assert.equal(data.findings[0].title, finding.title);
  assert.equal(data.findings[0].description, finding.description);
});

test("normalizeFindings anchors a range-only finding at startLine; no line at all still fails validation", () => {
  const { line, ...rest } = sample.findings[0];
  const ranged = normalizeFindings({ summary: "s", findings: [{ ...rest, startLine: 7, endLine: 9 }] }).data;
  assert.equal(ranged.findings[0].line, 7);
  assert.equal(validateFindings(ranged).ok, true);
  const bare = normalizeFindings({ summary: "s", findings: [rest] }).data;
  assert.equal(validateFindings(bare).ok, false);
});
