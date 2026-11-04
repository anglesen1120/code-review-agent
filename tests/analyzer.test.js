import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpencodeConfig, childEnv, extractFindings, runAnalysis, splitModel } from "../src/analyzer.js";

const finding = {
  severity: "Critical",
  category: "security",
  file: "src/a.js",
  line: 3,
  title: "SQL injection",
  description: "d",
  suggestion: "Use params:\n```js\ndb.query('select ?', [x])\n```",
};
const events = (...texts) => texts.map((text) => JSON.stringify({ type: "text", part: { text } })).join("\n");

test("extractFindings: plain JSON", () => {
  const { data } = extractFindings(events(JSON.stringify({ summary: "s", findings: [finding] })));
  assert.equal(data.findings[0].title, "SQL injection");
});

test("extractFindings: prose around JSON whose suggestion contains a code fence", () => {
  const text = `Here is my review:\n${JSON.stringify({ summary: "s", findings: [finding] })}\nThanks!`;
  const { data } = extractFindings(events(text));
  assert.ok(data, "balanced-brace scan must recover the object");
  assert.match(data.findings[0].suggestion, /db\.query/);
});

test("extractFindings: fenced JSON", () => {
  const { data } = extractFindings(events("```json\n" + JSON.stringify({ summary: "s", findings: [] }) + "\n```"));
  assert.deepEqual(data, { summary: "s", findings: [] });
});

test("extractFindings: invalid object reports schema errors", () => {
  const { data, errors } = extractFindings(events(JSON.stringify({ summary: "s", findings: [{ ...finding, severity: "Blocker" }] })));
  assert.equal(data, null);
  assert.match(errors.join(), /severity/);
});

test("extractFindings: ignores non-text events and garbage lines", () => {
  const stream = ["not json", JSON.stringify({ type: "tool", part: {} }), events(JSON.stringify({ summary: "s", findings: [] }))].join("\n");
  assert.ok(extractFindings(stream).data);
  assert.equal(extractFindings("").data, null);
});

test("extractFindings: normalizes absolute workspace paths", () => {
  const { data } = extractFindings(events(JSON.stringify({ summary: "s", findings: [{ ...finding, file: "/w/r/src/a.js" }] })), { workspace: "/w/r" });
  assert.equal(data.findings[0].file, "src/a.js");
});

test("buildOpencodeConfig is deny-by-default with no exfiltration channel", () => {
  const cfg = buildOpencodeConfig({ model: "go/m", baseUrl: "https://x/v1", prompt: "p", scratchDir: "/tmp/cra/" });
  const p = cfg.agent["code-reviewer"].permission;
  assert.equal(p["*"], "deny");
  for (const k of ["bash", "edit", "webfetch", "websearch", "task"]) assert.equal(p[k], "deny", k);
  assert.equal(p.read["*.env"], "deny");
  assert.equal(p.read["*/.git/*"], "deny");
  assert.deepEqual(p.external_directory, { "*": "deny", "/tmp/cra/*": "allow" });
  // Last matching rule wins in opencode: catch-all must come first.
  assert.equal(Object.keys(p.external_directory)[0], "*");
  assert.equal(cfg.provider.go.options.apiKey, "{env:CRA_API_KEY}");
  assert.equal(cfg.agent["code-reviewer"].model, "go/m");
});

test("splitModel gives bare names a provider", () => {
  assert.deepEqual(splitModel("m"), { providerName: "cra", modelName: "m" });
  assert.deepEqual(splitModel("a/b/c"), { providerName: "a", modelName: "b/c" });
});

test("childEnv never forwards CI tokens", () => {
  const env = childEnv(
    { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "t", GITLAB_TOKEN: "t", CI_JOB_TOKEN: "t", DEEPSEEK_API_KEY: "k", HTTPS_PROXY: "p", ACTIONS_RUNTIME_TOKEN: "t" },
    "key",
    "/s/opencode.json",
  );
  assert.deepEqual(Object.keys(env).sort(), ["CRA_API_KEY", "HOME", "HTTPS_PROXY", "OPENCODE_CONFIG", "OPENCODE_DISABLE_PROJECT_CONFIG", "PATH"]);
});

// ---- runAnalysis with a fake opencode binary ----

function fakeOpencode(dir, body) {
  const bin = join(dir, "fake-opencode");
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("runAnalysis: no key -> error, no process spawned", async () => {
  const r = await runAnalysis({ scratchDir: "/nonexistent", apiKey: "", env: {} });
  assert.match(r.error, /API key/);
});

test("runAnalysis: valid output on first attempt; child sees only allow-listed env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const out = JSON.stringify({ type: "text", part: { text: JSON.stringify({ summary: "ok", findings: [] }) } });
  const bin = fakeOpencode(dir, `require("fs").writeFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify(process.env)); console.log(${JSON.stringify(out)});`);
  const r = await runAnalysis({
    scratchDir: dir, diffPath: join(dir, "pr.diff"), workspace: dir, baseSha: "a", headSha: "b",
    apiKey: "k", env: { PATH: process.env.PATH, GITHUB_TOKEN: "secret" }, opencodeBin: bin, log: () => {},
  });
  assert.equal(r.error, null);
  assert.equal(r.data.summary, "ok");
  const seen = JSON.parse(readFileSync(join(dir, "env.json"), "utf8"));
  assert.equal(seen.GITHUB_TOKEN, undefined);
  assert.equal(seen.CRA_API_KEY, "k");
  assert.equal(seen.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
});

test("runAnalysis: retries once with strict instruction, then reports failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const bin = fakeOpencode(dir, `require("fs").appendFileSync(${JSON.stringify(join(dir, "calls"))}, "x"); console.log(JSON.stringify({type:"text",part:{text:"I refuse"}}));`);
  const logs = [];
  const r = await runAnalysis({
    scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "k", env: { PATH: process.env.PATH }, opencodeBin: bin, log: (m) => logs.push(m),
  });
  assert.equal(r.data, null);
  assert.match(r.error, /invalid findings/);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "xx");
});

test("runAnalysis: hung opencode is killed at the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const bin = fakeOpencode(dir, "setTimeout(() => {}, 60000);");
  const r = await runAnalysis({
    scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "k", env: { PATH: process.env.PATH }, opencodeBin: bin, timeoutMs: 300, log: () => {},
  });
  assert.equal(r.data, null);
  assert.match(r.error, /timeout/);
});

test("runAnalysis: missing binary is a clean error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const r = await runAnalysis({ scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "k", env: { PATH: "" }, opencodeBin: join(dir, "nope"), log: () => {} });
  assert.match(r.error, /cannot start/);
});

test("runAnalysis: non-retryable provider error is surfaced and not retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const ev = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Model is unavailable.", statusCode: 400, isRetryable: false } } });
  const bin = fakeOpencode(dir, `require("fs").appendFileSync(${JSON.stringify(join(dir, "calls"))}, "x"); console.log(${JSON.stringify(ev)});`);
  const r = await runAnalysis({ scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "k", env: { PATH: process.env.PATH }, opencodeBin: bin, log: () => {} });
  assert.match(r.error, /provider error: 400 Model is unavailable/);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "x");
});
