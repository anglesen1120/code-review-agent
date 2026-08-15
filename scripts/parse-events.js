// Extracts findings JSON from `opencode run --format json` event stream.
// Concatenates all `text` events, strips markdown fences, extracts the outermost
// JSON object, validates it against the schema, and writes findings.json.
// Exit 0 = valid findings written; exit 1 = invalid/missing (also writes a
// degraded findings file so the poster can still update the summary).
import { readFileSync, writeFileSync } from "node:fs";
import { validateFindings } from "./validate.js";

const [eventsFile, outFile] = process.argv.slice(2);
if (!eventsFile || !outFile) {
  console.error("usage: node parse-events.js <events.jsonl> <findings.json> [--print-errors]");
  process.exit(2);
}

const lines = readFileSync(eventsFile, "utf8").split("\n");
const textParts = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  if (ev.type === "text" && ev.part && typeof ev.part.text === "string") {
    textParts.push(ev.part.text);
  }
}

const raw = textParts.join("\n");
const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
const candidate = fence ? fence[1] : raw;
const start = candidate.indexOf("{");
const end = candidate.lastIndexOf("}");
let data = null;
if (start !== -1 && end > start) {
  try {
    data = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    data = null;
  }
}

const result = validateFindings(data);
if (result.ok && data) {
  writeFileSync(outFile, JSON.stringify(data, null, 2));
  process.exit(0);
}

writeFileSync(
  outFile,
  JSON.stringify(
    { summary: "Analysis failed to produce valid findings. See workflow logs.", findings: [] },
    null,
    2,
  ),
);
if (process.argv.includes("--print-errors")) {
  console.error("parse-events: " + (result.errors?.join("; ") || "no JSON object found in model output"));
}
process.exit(1);
