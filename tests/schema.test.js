import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateFindings } from "../scripts/validate.js";

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
