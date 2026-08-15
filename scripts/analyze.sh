#!/usr/bin/env bash
#
# Analyzer: run the opencode agent headlessly to turn a PR diff into
# schema-valid findings.json. Never writes to the repo; degrades gracefully
# (never hard-fails the PR review).
#
# Env (set by action.yml, or by the local skill / manual dry-run):
#   MODE=ci|local
#   ACTION_PATH=<repo root of code-review-agent>
#   RUNNER_TEMP (CI) — scratch dir is $RUNNER_TEMP/cra
#   CI inputs may arrive via $SCRATCH/env written by action.yml:
#     PR_NUMBER BASE_SHA HEAD_SHA CHANGED_FILES MODEL BASE_URL
# Optional:
#   MODEL     provider/model, default deepseek/deepseek-v4-flash
#   BASE_URL  provider endpoint, default https://api.deepseek.com/v1
#   API_KEY_ENV  env var name holding the key, default DEEPSEEK_API_KEY
set -uo pipefail

# Local mode: write into the repo's gitignored .review/ dir so results are easy
# to find. CI mode: use the runner's temp dir.
if [ "${MODE:-ci}" = "local" ] && [ -z "${RUNNER_TEMP:-}" ]; then
  SCRATCH="${LOCAL_SCRATCH:-$(pwd)/.review}"
else
  SCRATCH="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cra"
fi
mkdir -p "$SCRATCH"
ACTION_PATH="${ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ -f "$SCRATCH/env" ]; then
  # shellcheck disable=SC1090
  . "$SCRATCH/env"
fi

MODEL="${MODEL:-deepseek/deepseek-v4-flash}"
BASE_URL="${BASE_URL:-https://api.deepseek.com/v1}"
API_KEY_ENV="${API_KEY_ENV:-DEEPSEEK_API_KEY}"

# Local mode: if no diff was provided, review working-tree changes vs HEAD.
if [ ! -s "$SCRATCH/pr.diff" ]; then
  git diff HEAD -- . >"$SCRATCH/pr.diff" 2>/dev/null || true
fi

if [ ! -s "$SCRATCH/pr.diff" ]; then
  echo "code-review-agent: no diff to review; skipping analysis." >&2
  echo '{"summary":"No code changes to review.","findings":[]}' >"$SCRATCH/findings.json"
  exit 0
fi

# 1) Generate the opencode config: provider + read-only code-reviewer agent.
OUT="$SCRATCH/opencode.json" BASE_URL="$BASE_URL" MODEL="$MODEL" \
  PROMPT_FILE="$ACTION_PATH/prompts/reviewer-system.md" API_KEY_ENV="$API_KEY_ENV" \
  node "$ACTION_PATH/scripts/make-config.js" >/dev/null

export OPENCODE_CONFIG="$SCRATCH/opencode.json"
# Ignore consumer-repo opencode.json + AGENTS.md: they must not influence us.
export OPENCODE_DISABLE_PROJECT_CONFIG=1

if [ -z "${!API_KEY_ENV:-}" ]; then
  echo "code-review-agent: $API_KEY_ENV is not set; cannot run analysis." >&2
  echo '{"summary":"Analysis skipped: API key not configured.","findings":[]}' >"$SCRATCH/findings.json"
  echo "analysis_error=1" >"$SCRATCH/error"
  exit 0
fi

PROMPT="Review PR #${PR_NUMBER:-<local>} (base=${BASE_SHA:-HEAD~1}, head=${HEAD_SHA:-HEAD}). Diff file: $SCRATCH/pr.diff (repo-relative paths). Repo root: ${GITHUB_WORKSPACE:-$(pwd)}. If present, read $SCRATCH/existing_threads.json for continuity. Output ONLY the JSON findings object described in your system prompt."
STRICT="Output ONLY the JSON object. No markdown fences, no prose, no commentary."

run() { # $1 = events file, $2 = extra instruction
  opencode run --agent code-reviewer --format json --model "$MODEL" "$PROMPT $2" \
    >"$1" 2>"$SCRATCH/opencode.err"
}

run "$SCRATCH/events.jsonl" ""
if node "$ACTION_PATH/scripts/parse-events.js" "$SCRATCH/events.jsonl" "$SCRATCH/findings.json"; then
  exit 0
fi

# Retry once with a stricter instruction.
run "$SCRATCH/events.retry.jsonl" "$STRICT"
if node "$ACTION_PATH/scripts/parse-events.js" "$SCRATCH/events.retry.jsonl" "$SCRATCH/findings.json" --print-errors; then
  exit 0
fi

echo "code-review-agent: analysis produced invalid findings; degrading." >&2
echo '{"summary":"Analysis failed to produce valid findings. See workflow logs.","findings":[]}' >"$SCRATCH/findings.json"
echo "analysis_error=1" >"$SCRATCH/error"
exit 0
