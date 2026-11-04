import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpencodeConfig, childEnv, extractFindings, runAnalysis, scrubSecrets, secretValues, splitModel } from "../src/analyzer.js";

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
  // Hardening keys verified accepted by opencode 1.18.18 (`debug config`).
  assert.equal(cfg.autoupdate, false);
  assert.equal(cfg.share, "disabled");
  assert.equal(cfg.snapshot, false);
  assert.equal(cfg.lsp, false);
  assert.equal(p.lsp, "deny");
  // opencode 1.18.18 matches this string exactly to pick its request adapter.
  assert.equal(cfg.provider.go.npm, "@ai-sdk/openai-compatible");
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
  assert.deepEqual(Object.keys(env).sort(), [
    "CRA_API_KEY",
    "HOME",
    "HTTPS_PROXY",
    "OPENCODE_CONFIG",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_DISABLE_LSP_DOWNLOAD",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "PATH",
  ]);
});

test("childEnv drops every inherited OPENCODE_* so config cannot be overridden", () => {
  const env = childEnv(
    {
      PATH: "/bin",
      OPENCODE_CONFIG_CONTENT: '{"agent":{"code-reviewer":{"permission":{"bash":"allow"}}}}',
      OPENCODE_PERMISSION: '{"bash":"allow"}',
      OPENCODE_CONFIG: "/attacker/opencode.json",
      OPENCODE_CONFIG_DIR: "/attacker/cfg",
      OPENCODE_AUTO_SHARE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      OPENCODE_DISABLE_AUTOUPDATE: "0",
    },
    "key",
    "/s/opencode.json",
  );
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.OPENCODE_PERMISSION, undefined);
  assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(env.OPENCODE_AUTO_SHARE, undefined);
  assert.equal(env.OPENCODE_CONFIG, "/s/opencode.json");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(env.OPENCODE_DISABLE_LSP_DOWNLOAD, "1");
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1");
});

test("secretValues collects the key and credential-like env values, longest first", () => {
  const values = secretValues({ GITHUB_TOKEN: "abc12345", PATH: "/bin", MY_NOT_A_SECRET_KEY: "xyz9" }, "abc12345long");
  assert.deepEqual(values, ["abc12345long", "abc12345", "xyz9"]);
  assert.equal(scrubSecrets("token abc12345long and abc12345", values), "token [REDACTED] and [REDACTED]");
});

test("secretValues covers short values and their JSON-escaped form", () => {
  const password = 'p"w\\d';
  const escaped = JSON.stringify(password).slice(1, -1);
  const values = secretValues({ PASSWORD: password, SHORT_TOKEN: "zqx" }, "k");
  assert.ok(values.includes(password));
  assert.ok(values.includes(escaped));
  assert.ok(values.includes("zqx"));
  const text = `raw=${password} json=${escaped}`;
  const scrubbed = scrubSecrets(text, values);
  assert.ok(!scrubbed.includes(password));
  assert.ok(!scrubbed.includes(escaped));
  assert.equal(scrubbed.split("[REDACTED]").length - 1, 2);
});

test("secretValues covers trimmed, per-line and proxy credentials", () => {
  const values = secretValues({ PASSWORD: "  spaced  ", PEM_KEY: "-----BEGIN\nlineone\n-----END", HTTPS_PROXY: "http://u:sekret@proxy:3128" }, "");
  for (const v of ["spaced", "  spaced  ", "lineone", "-----BEGIN", "u:sekret", "sekret"]) {
    assert.ok(values.includes(v), `missing ${JSON.stringify(v)}`);
  }
  assert.equal(scrubSecrets("auth sekret and u:sekret", values), "auth [REDACTED] and [REDACTED]");
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
  assert.equal(seen.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(seen.OPENCODE_DISABLE_LSP_DOWNLOAD, "1");
  assert.equal(seen.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1");
});

test("runAnalysis: parent OPENCODE_CONFIG_CONTENT/OPENCODE_PERMISSION never reach the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const out = JSON.stringify({ type: "text", part: { text: JSON.stringify({ summary: "ok", findings: [] }) } });
  const bin = fakeOpencode(dir, `require("fs").writeFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify(process.env)); console.log(${JSON.stringify(out)});`);
  const r = await runAnalysis({
    scratchDir: dir, diffPath: join(dir, "pr.diff"), workspace: dir, apiKey: "key-1234", opencodeBin: bin, log: () => {},
    env: {
      PATH: process.env.PATH,
      OPENCODE_CONFIG_CONTENT: '{"agent":{"code-reviewer":{"permission":{"bash":"allow"}}}}',
      OPENCODE_PERMISSION: '{"bash":"allow"}',
      OPENCODE_CONFIG_DIR: "/attacker/cfg",
      OPENCODE_AUTO_SHARE: "1",
    },
  });
  assert.equal(r.error, null);
  const seen = JSON.parse(readFileSync(join(dir, "env.json"), "utf8"));
  for (const k of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", "OPENCODE_CONFIG_DIR", "OPENCODE_AUTO_SHARE"]) {
    assert.equal(seen[k], undefined, `${k} must not be forwarded`);
  }
  assert.equal(seen.OPENCODE_CONFIG, join(dir, "opencode.json"));
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

test("runAnalysis: valid JSON followed by a non-zero exit fails closed after the retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const out = JSON.stringify({ type: "text", part: { text: JSON.stringify({ summary: "ok", findings: [] }) } });
  const bin = fakeOpencode(
    dir,
    `require("fs").appendFileSync(${JSON.stringify(join(dir, "calls"))}, "x"); console.log(${JSON.stringify(out)}); setTimeout(() => process.exit(9), 50);`,
  );
  const logs = [];
  const r = await runAnalysis({
    scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "key-1234", env: { PATH: process.env.PATH },
    opencodeBin: bin, log: (m) => logs.push(m),
  });
  assert.equal(r.data, null);
  assert.match(r.error, /exited with code 9/);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "xx", "retry behaviour is unchanged");
  assert.match(logs.join("\n"), /exited with code 9/);
});

test("runAnalysis: a killed child is a failure even with valid findings on stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const out = JSON.stringify({ type: "text", part: { text: JSON.stringify({ summary: "ok", findings: [] }) } });
  const bin = fakeOpencode(dir, `console.log(${JSON.stringify(out)}); process.kill(process.pid, "SIGKILL");`);
  const r = await runAnalysis({
    scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "key-1234", env: { PATH: process.env.PATH },
    opencodeBin: bin, log: () => {},
  });
  assert.equal(r.data, null);
  assert.match(r.error, /SIGKILL/);
});

test("runAnalysis: API key and token env values are scrubbed from logs and the error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const apiKey = "sk-live-abcdef123456";
  const token = "ghp_supersecret9876";
  const bin = fakeOpencode(
    dir,
    `require("fs").appendFileSync(${JSON.stringify(join(dir, "calls"))}, "x");
     console.error("authorization: Bearer ${apiKey} token=${token}");
     console.log(${JSON.stringify(JSON.stringify({ type: "error", error: { name: "APIError", data: { message: `bad key ${apiKey}`, statusCode: 401 } } }))});
     setTimeout(() => process.exit(1), 50);`,
  );
  const logs = [];
  const r = await runAnalysis({
    scratchDir: dir, diffPath: "d", workspace: dir, apiKey, env: { PATH: process.env.PATH, GITHUB_TOKEN: token },
    opencodeBin: bin, log: (m) => logs.push(m),
  });
  assert.equal(r.data, null);
  const seen = logs.join("\n") + "\n" + r.error;
  assert.ok(!seen.includes(apiKey), "API key leaked");
  assert.ok(!seen.includes(token), "CI token leaked");
  assert.match(r.error, /\[REDACTED\]/);
  assert.match(logs.join("\n"), /\[REDACTED\]/);
});

test("runAnalysis: short and JSON-escaped credential values never reach the logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cra-an-"));
  const password = 'p"w\\d';
  const shortToken = "zqx";
  const ev = JSON.stringify({
    type: "error",
    error: { name: "APIError", data: { message: `bad password ${password}`, statusCode: 401, isRetryable: false } },
  });
  const bin = fakeOpencode(dir, `console.error("short token ${shortToken}"); console.log(${JSON.stringify(ev)});`);
  const logs = [];
  const r = await runAnalysis({
    scratchDir: dir, diffPath: "d", workspace: dir, apiKey: "key-1234",
    env: { PATH: process.env.PATH, SHORT_TOKEN: shortToken, PASSWORD: password },
    opencodeBin: bin, log: (m) => logs.push(m),
  });
  assert.equal(r.data, null);
  const seen = logs.join("\n") + "\n" + r.error;
  assert.ok(!seen.includes(password), "raw password leaked");
  assert.ok(!seen.includes(JSON.stringify(password).slice(1, -1)), "escaped password leaked");
  assert.ok(!seen.includes(shortToken), "short token leaked");
  assert.match(r.error, /\[REDACTED\]/);
  assert.match(logs.join("\n"), /\[REDACTED\]/);
});
