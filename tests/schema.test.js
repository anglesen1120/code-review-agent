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
