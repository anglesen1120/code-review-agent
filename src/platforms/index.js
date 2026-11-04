// Platform resolution. "auto" picks the CI the process runs in; anything
// without a supported review API (Jenkins, Bitbucket, Azure, local) is
// "none": findings go to report files + exit code only.
import { createGitHubPlatform, detectGitHub } from "./github.js";
import { createGitLabPlatform, detectGitLab } from "./gitlab.js";

export const PLATFORMS = ["auto", "github", "gitlab", "none"];

export function detectPlatform(env) {
  if (detectGitHub(env)) return "github";
  if (detectGitLab(env)) return "gitlab";
  return "none";
}

/** @returns {object|null} adapter, or null for "none" */
export function createPlatform(name, opts = {}) {
  const env = opts.env ?? process.env;
  const resolved = name === "auto" ? detectPlatform(env) : name;
  if (resolved === "github") return createGitHubPlatform({ ...opts, env });
  if (resolved === "gitlab") return createGitLabPlatform({ ...opts, env });
  if (resolved === "none") return null;
  throw new Error(`unknown platform '${name}' (expected one of ${PLATFORMS.join(", ")})`);
}

/**
 * Best-effort base ref for CI systems without an adapter, from their
 * pull-request env vars. Returns a ref like "origin/main" or null.
 */
export function inferBaseRef(env) {
  const target =
    env.BITBUCKET_PR_DESTINATION_BRANCH ||
    env.CHANGE_TARGET || // Jenkins multibranch
    env.SYSTEM_PULLREQUEST_TARGETBRANCH || // Azure Pipelines
    env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ||
    env.GITHUB_BASE_REF;
  if (!target) return null;
  return `origin/${target.replace(/^refs\/heads\//, "")}`;
}
