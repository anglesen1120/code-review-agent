// Generates the opencode.json used for the read-only code-reviewer run.
// Zero dependencies. Reads env:
//   BASE_URL     default https://opencode.ai/zen/go/v1 (OpenCode Go)
//   MODEL        provider/model, default go/deepseek-v4-flash
//   PROMPT_FILE  path to prompts/reviewer-system.md (embedded as the agent prompt)
//   API_KEY_ENV  env var name holding the provider API key, default DEEPSEEK_API_KEY
//   OUT          output path for opencode.json
import { readFileSync, writeFileSync } from "node:fs";

const baseUrl = process.env.BASE_URL || "https://opencode.ai/zen/go/v1";
const model = process.env.MODEL || "go/deepseek-v4-flash";
const slash = model.indexOf("/");
const providerName = slash === -1 ? "deepseek" : model.slice(0, slash);
const modelName = slash === -1 ? model : model.slice(slash + 1);
const apiKeyEnv = process.env.API_KEY_ENV || "DEEPSEEK_API_KEY";
const out = process.env.OUT;
if (!out) {
  console.error("make-config: OUT is required");
  process.exit(1);
}

let prompt = "";
if (process.env.PROMPT_FILE) {
  try {
    prompt = readFileSync(process.env.PROMPT_FILE, "utf8");
  } catch {
    console.error(`make-config: cannot read PROMPT_FILE ${process.env.PROMPT_FILE}`);
  }
}

const config = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    [providerName]: {
      npm: "@ai-sdk/openai-compatible",
      name: providerName,
      options: {
        baseURL: baseUrl,
        apiKey: `{env:${apiKeyEnv}}`,
      },
      models: {
        [modelName]: { name: modelName },
      },
    },
  },
  agent: {
    "code-reviewer": {
      description: "Reviews PR diffs for bugs, security, and quality. Read-only.",
      mode: "primary",
      model: `${providerName}/${modelName}`,
      permission: {
        edit: "deny",
        write: "deny",
        bash: "deny",
        webfetch: "allow",
        // The diff + existing_threads.json live in the runner's temp scratch
        // dir (outside the repo), so the read-only agent must be allowed to
        // read them. It stays unable to write, edit, or execute anything.
        read: "allow",
        external_directory: "allow",
      },
      prompt,
    },
  },
};

writeFileSync(out, JSON.stringify(config, null, 2));
console.log(out);
