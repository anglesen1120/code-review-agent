// GitHub platform adapter (GitHub Actions and GHES) over native fetch.
//
// Ported from the old `gh`-CLI poster (scripts/post-review.js). This module is
// the only place that talks GitHub: lifecycle.js decides what to post, keep or
// resolve; the adapter only performs the API calls.
//
// Identity note: the Actions GITHUB_TOKEN shows up as `github-actions` (the app)
// in some responses and `github-actions[bot]` in others, so both spellings are
// accepted for the bot identity.
import { readFileSync } from "node:fs";
import {
  SUMMARY_MARKER,
  isOwnThreadBody,
  markdownThread,
  parseReviewedSha,
  parseThreadBody,
  threadKey,
} from "../lifecycle.js";

const ACTIONS_LOGINS = new Set(["github-actions", "github-actions[bot]"]);
const API_VERSION = "2022-11-28";
const USER_AGENT = "code-review-agent";
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
// Cap only the exponential backoff we generate ourselves. A server-provided
// Retry-After is honoured up to MAX_RETRY_AFTER_MS; above that we fail loudly
// instead of stalling the CI job for hours (or overflowing setTimeout).
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 120_000;
const MAX_PAGES = 1_000;
const PER_PAGE = 100;
const STATUS_CONTEXT = "code-review-agent";
const MAX_STATUS_DESCRIPTION = 140;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const REPO_PART_RE = /^[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[\x21-\x7e]+$/;

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            comments(first: 1) { nodes { author { login } body } }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation ResolveThread($id: ID!) {
    resolveReviewThread(input: { threadId: $id }) {
      thread { id isResolved }
    }
  }
`;

export class GitHubApiError extends Error {
  constructor(message, { status = 0, method, path, body, cause } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

/** Detect GitHub Actions (or a caller emulating it for GHES). */
export function detectGitHub(env = process.env) {
  return env?.GITHUB_ACTIONS === "true";
}

/**
 * GitHub reports the Actions token identity under two spellings; an exact match
 * with the configured bot login always wins.
 */
export function isBotAuthor(login, botLogin) {
  if (!login) return false;
  if (login === botLogin) return true;
  return ACTIONS_LOGINS.has(login) && ACTIONS_LOGINS.has(botLogin);
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const trimTrailingSlashes = (value) => String(value).replace(/\/+$/, "");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toPrNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function apiUrlFrom(env) {
  return trimTrailingSlashes(env.GITHUB_API_URL || "https://api.github.com");
}

/** `https://api.github.com` -> `…/graphql`; GHES `https://host/api/v3` -> `https://host/api/graphql`. */
function graphqlUrlFrom(apiUrl) {
  if (apiUrl.endsWith("/api/v3")) return `${apiUrl.slice(0, -"/v3".length)}/graphql`;
  return `${apiUrl}/graphql`;
}

function loadEvent(env) {
  if (!nonEmpty(env.GITHUB_EVENT_PATH)) return { event: null, error: null };
  try {
    return { event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")), error: null };
  } catch (error) {
    return { event: null, error };
  }
}

function resolveRepository(env) {
  const raw = nonEmpty(env.GITHUB_REPOSITORY) ? env.GITHUB_REPOSITORY.trim() : "";
  const parts = raw.split("/");
  const validPart = (part) => REPO_PART_RE.test(part) && part !== "." && part !== "..";
  if (parts.length !== 2 || !parts[0] || !parts[1] || !parts.every(validPart)) {
    throw new Error("GitHub adapter: GITHUB_REPOSITORY is required in owner/repo form");
  }
  return { owner: parts[0], repo: parts[1] };
}

/** SHAs are interpolated into URL paths, so only hex is accepted. */
function resolveSha(value, name) {
  if (!nonEmpty(value)) return null;
  const sha = value.trim();
  if (!SHA_RE.test(sha)) {
    throw new Error(`GitHub adapter: ${name} must be a 7-64 character hex SHA`);
  }
  return sha;
}

function resolveContext(env) {
  const { event, error } = loadEvent(env);
  const pull = event?.pull_request ?? {};
  const prNumber = toPrNumber(env.PR_NUMBER) ?? toPrNumber(pull.number);
  if (!prNumber) {
    const hint = error
      ? `GITHUB_EVENT_PATH could not be read (${error.message}) and PR_NUMBER is not set`
      : "set GITHUB_EVENT_PATH with pull_request.number, or PR_NUMBER";
    throw new Error(`GitHub adapter: pull request number not found (${hint})`);
  }
  const baseSha = resolveSha(nonEmpty(env.BASE_SHA) ? env.BASE_SHA : pull.base?.sha, "BASE_SHA (or pull_request.base.sha)");
  const headSha = resolveSha(nonEmpty(env.HEAD_SHA) ? env.HEAD_SHA : pull.head?.sha, "HEAD_SHA (or pull_request.head.sha)");
  return { prNumber, baseSha, headSha, workspace: env.GITHUB_WORKSPACE || process.cwd() };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (value != null) return value;
  }
  if (typeof headers === "object") {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) return headers[key];
  }
  return null;
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (match && match[2].split(/\s+/).includes("next")) return match[1];
  }
  return null;
}

/** One-line, bounded text for logs and thrown errors (no log-command injection). */
function cleanMessage(value, max = 300) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Resolve a Link `next` URL against the API base. The Authorization header is
 * attached to every request, so a page URL on another origin is refused rather
 * than leaking the token to a host GitHub did not name.
 */
function resolveNextPageUrl(linkHeader, apiUrl) {
  const next = nextPageUrl(linkHeader);
  if (!next) return null;
  let resolved;
  try {
    resolved = new URL(next, `${apiUrl}/`);
  } catch (error) {
    throw new GitHubApiError(`GitHub adapter: invalid pagination URL '${cleanMessage(next)}'`, {
      path: cleanMessage(next),
      cause: error,
    });
  }
  if (resolved.origin !== new URL(apiUrl).origin) {
    throw new GitHubApiError(`GitHub adapter: refusing cross-origin pagination URL '${resolved.origin}'`, {
      path: resolved.pathname,
    });
  }
  return resolved.href;
}

function parseRetryAfter(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

function truncateStatusDescription(description) {
  const chars = Array.from(String(description ?? ""));
  return chars.length > MAX_STATUS_DESCRIPTION ? chars.slice(0, MAX_STATUS_DESCRIPTION).join("") : chars.join("");
}

const isAbsoluteUrl = (value) => /^https?:\/\//i.test(value);

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {Record<string,string>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(msg:string)=>void} [options.log] never receives secrets
 * @param {(ms:number)=>Promise<void>} [options.sleep] injected by tests
 * @param {number} [options.retryBaseMs]
 */
export function createGitHubPlatform({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.error,
  sleep,
  retryBaseMs = RETRY_BASE_MS,
} = {}) {
  const token = nonEmpty(env.GITHUB_TOKEN)
    ? env.GITHUB_TOKEN.trim()
    : nonEmpty(env.CRA_GITHUB_TOKEN)
      ? env.CRA_GITHUB_TOKEN.trim()
      : "";
  if (!token) {
    throw new Error("GitHub adapter: a token is required (GITHUB_TOKEN or CRA_GITHUB_TOKEN)");
  }
  if (!TOKEN_RE.test(token)) {
    throw new Error("GitHub adapter: the token contains characters that cannot be sent in an HTTP header");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("GitHub adapter: fetch is not available (pass fetchImpl or use Node >= 20)");
  }

  const { owner, repo } = resolveRepository(env);
  const context = resolveContext(env);
  const apiUrl = apiUrlFrom(env);
  const graphqlUrl = graphqlUrlFrom(apiUrl);
  const serverUrl = trimTrailingSlashes(env.GITHUB_SERVER_URL || "https://github.com");
  const botLogin = nonEmpty(env.BOT_LOGIN) ? env.BOT_LOGIN.trim() : "github-actions";
  const pause = typeof sleep === "function" ? sleep : defaultSleep;
  const baseDelay = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : RETRY_BASE_MS;
  const logLine = typeof log === "function" ? log : () => {};
  const backoff = (attempt) => Math.min(MAX_RETRY_DELAY_MS, baseDelay * 2 ** (attempt - 1));
  const scrub = (value) => cleanMessage(String(value ?? "").split(token).join("***"));

  const repoPath = `/repos/${owner}/${repo}`;
  const pullPath = `${repoPath}/pulls/${context.prNumber}`;
  const issuePath = `${repoPath}/issues/${context.prNumber}`;

  const headersFor = (hasBody) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  };

  const absoluteUrl = (pathOrUrl) =>
    isAbsoluteUrl(pathOrUrl) ? pathOrUrl : `${apiUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

  const labelFor = (pathOrUrl, url) => {
    if (!isAbsoluteUrl(pathOrUrl)) return pathOrUrl;
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return pathOrUrl;
    }
  };

  async function decode(res) {
    if (!res) return null;
    if (typeof res.text === "function") {
      let text;
      try {
        text = await res.text();
      } catch {
        return null;
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (typeof res.json === "function") {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    return null;
  }

  async function failureMessage(res, status) {
    const data = await decode(res);
    if (data && typeof data === "object") {
      const parts = [];
      if (typeof data.message === "string" && data.message) parts.push(data.message);
      if (Array.isArray(data.errors)) {
        for (const err of data.errors) {
          if (typeof err === "string") parts.push(err);
          else if (err?.message) parts.push(err.message);
        }
      }
      if (parts.length > 0) return scrub(parts.join("; "));
    }
    if (typeof data === "string" && data.trim()) return scrub(data);
    return status ? `HTTP ${status}` : "";
  }

  /** JSON request with retry on 429/5xx/network errors; fail fast on other 4xx. */
  async function request(method, pathOrUrl, body) {
    const url = absoluteUrl(pathOrUrl);
    const path = labelFor(pathOrUrl, url);
    const hasBody = body !== undefined;
    let lastError = null;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: headersFor(hasBody),
          body: hasBody ? JSON.stringify(body) : undefined,
          redirect: "manual",
        });
      } catch (cause) {
        lastError = new GitHubApiError(
          `GitHub ${method} ${path} failed: network error: ${scrub(cause?.message ?? cause)}`,
          { method, path, status: 0, cause },
        );
        if (attempt < RETRY_ATTEMPTS) {
          const delay = backoff(attempt);
          logLine(`code-review-agent: ${lastError.message}; retrying in ${delay}ms (${attempt}/${RETRY_ATTEMPTS})`);
          await pause(delay);
          continue;
        }
        throw lastError;
      }

      const status = Number(res?.status ?? 0);
      const ok = typeof res?.ok === "boolean" ? res.ok : status >= 200 && status < 300;
      if (ok) {
        const data = await decode(res);
        if (data === null && status !== 204) {
          throw new GitHubApiError(`GitHub ${method} ${path} returned an empty or non-JSON response body`, {
            method,
            path,
            status,
          });
        }
        return { data, headers: res?.headers };
      }

      const location = headerValue(res?.headers, "location");
      const detail =
        status >= 300 && status < 400
          ? `unexpected redirect${location ? ` to ${scrub(location)}` : ""}`
          : await failureMessage(res, status);
      lastError = new GitHubApiError(
        `GitHub ${method} ${path} failed with status ${status}${detail ? `: ${detail}` : ""}`,
        { method, path, status, body: detail },
      );
      const retryable = status === 429 || status >= 500;
      if (retryable && attempt < RETRY_ATTEMPTS) {
        const requested = parseRetryAfter(headerValue(res?.headers, "retry-after"));
        if (requested != null && requested > MAX_RETRY_AFTER_MS) {
          throw new GitHubApiError(
            `${lastError.message}; refusing a ${requested}ms Retry-After (limit ${MAX_RETRY_AFTER_MS}ms)`,
            { method, path, status, body: detail },
          );
        }
        const delay = requested ?? backoff(attempt);
        logLine(`code-review-agent: ${lastError.message}; retrying in ${delay}ms (${attempt}/${RETRY_ATTEMPTS})`);
        await pause(delay);
        continue;
      }
      throw lastError;
    }
    throw lastError ?? new GitHubApiError(`GitHub ${method} ${path} failed`, { method, path });
  }

  async function graphql(query, variables) {
    const { data } = await request("POST", graphqlUrl, { query, variables });
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const message = scrub(
        data.errors.map((err) => (typeof err === "string" ? err : err?.message ?? JSON.stringify(err))).join("; "),
      );
      throw new GitHubApiError(`GitHub GraphQL request failed: ${message}`, {
        method: "POST",
        path: labelFor(graphqlUrl, graphqlUrl),
        status: 200,
        body: data.errors,
      });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new GitHubApiError("GitHub GraphQL request returned an unexpected response body", {
        method: "POST",
        path: labelFor(graphqlUrl, graphqlUrl),
        status: 200,
      });
    }
    if (!data.data || typeof data.data !== "object") {
      throw new GitHubApiError("GitHub GraphQL response contained no data", {
        method: "POST",
        path: labelFor(graphqlUrl, graphqlUrl),
        status: 200,
      });
    }
    return data.data;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async function fetchReviewThreads() {
    const threads = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) {
        throw new GitHubApiError(`GitHub adapter: reviewThreads pagination exceeded ${MAX_PAGES} pages`, {
          method: "POST",
          path: labelFor(graphqlUrl, graphqlUrl),
          status: 200,
        });
      }
      const data = await graphql(REVIEW_THREADS_QUERY, {
        owner,
        name: repo,
        number: context.prNumber,
        cursor,
      });
      const pullRequest = data?.repository?.pullRequest;
      if (!pullRequest) {
        throw new GitHubApiError(
          `GitHub adapter: reviewThreads response has no repository.pullRequest for ${owner}/${repo}#${context.prNumber}`,
          { method: "POST", path: labelFor(graphqlUrl, graphqlUrl), status: 200 },
        );
      }
      const connection = pullRequest.reviewThreads;
      if (!connection) {
        throw new GitHubApiError("GitHub adapter: reviewThreads response has no reviewThreads connection", {
          method: "POST",
          path: labelFor(graphqlUrl, graphqlUrl),
          status: 200,
        });
      }

      for (const node of connection.nodes ?? []) {
        const root = node?.comments?.nodes?.[0];
        if (!root || !isBotAuthor(root.author?.login, botLogin)) continue;
        if (!isOwnThreadBody(root.body)) continue;
        const { severity, title } = parseThreadBody(root.body);
        const line = node.line ?? node.originalLine ?? 0;
        threads.push({
          id: node.id,
          key: threadKey({ file: node.path, line, title }),
          path: node.path,
          line,
          title,
          severity,
          isResolved: Boolean(node.isResolved),
          isOutdated: Boolean(node.isOutdated),
        });
      }

      if (!connection.pageInfo?.hasNextPage) break;
      const next = connection.pageInfo.endCursor ?? null;
      if (!next) {
        throw new GitHubApiError("GitHub adapter: reviewThreads pagination reported hasNextPage but no endCursor", {
          method: "POST",
          path: labelFor(graphqlUrl, graphqlUrl),
          status: 200,
        });
      }
      if (seenCursors.has(next)) {
        throw new GitHubApiError(`GitHub adapter: reviewThreads pagination repeated cursor '${cleanMessage(next)}'`, {
          method: "POST",
          path: labelFor(graphqlUrl, graphqlUrl),
          status: 200,
        });
      }
      seenCursors.add(next);
      cursor = next;
    }
    return threads;
  }

  async function listIssueComments() {
    const items = [];
    const seenUrls = new Set();
    const seenIds = new Set();
    let pathOrUrl = `${issuePath}/comments?per_page=${PER_PAGE}&page=1`;
    let page = 1;
    for (;;) {
      const url = absoluteUrl(pathOrUrl);
      if (page > MAX_PAGES) {
        throw new GitHubApiError(`GitHub adapter: issue comments pagination exceeded ${MAX_PAGES} pages`, {
          method: "GET",
          path: labelFor(url, url),
        });
      }
      if (seenUrls.has(url)) {
        throw new GitHubApiError(`GitHub adapter: issue comments pagination repeated URL '${cleanMessage(url)}'`, {
          method: "GET",
          path: labelFor(pathOrUrl, url),
        });
      }
      seenUrls.add(url);

      const { data, headers } = await request("GET", url);
      if (!Array.isArray(data)) {
        throw new GitHubApiError("GitHub adapter: issue comments response was not a JSON list", {
          method: "GET",
          path: labelFor(url, url),
        });
      }
      const batch = data;
      items.push(...batch);
      const freshIds = batch.filter((comment) => comment?.id != null && !seenIds.has(comment.id));
      for (const comment of batch) if (comment?.id != null) seenIds.add(comment.id);

      const next = resolveNextPageUrl(headerValue(headers, "link"), apiUrl);
      if (next) {
        pathOrUrl = next;
        page += 1;
        continue;
      }
      if (batch.length < PER_PAGE) break;
      if (batch.some((comment) => comment?.id != null) && freshIds.length === 0) {
        throw new GitHubApiError(`GitHub adapter: issue comments pagination did not advance past page ${page}`, {
          method: "GET",
          path: labelFor(url, url),
        });
      }
      page += 1;
      pathOrUrl = `${issuePath}/comments?per_page=${PER_PAGE}&page=${page}`;
    }
    return items;
  }

  async function fetchState() {
    const [threads, comments] = await Promise.all([fetchReviewThreads(), listIssueComments()]);
    let summaryBody = null;
    for (const comment of comments) {
      if (!isBotAuthor(comment?.user?.login, botLogin)) continue;
      if (typeof comment.body !== "string" || !comment.body.startsWith(SUMMARY_MARKER)) continue;
      summaryBody = comment.body;
    }
    return { threads, lastReviewedSha: summaryBody ? parseReviewedSha(summaryBody) : null };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async function postThreads(items = []) {
    const findings = (items ?? []).map((item) => item?.finding ?? item).filter(Boolean);
    if (findings.length === 0) return { posted: [], failed: [], reviewId: null };

    const toComment = (finding) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: markdownThread(finding),
    });
    const reviewBody = (comments) => {
      const payload = {
        event: "COMMENT",
        body: "Automated review from code-review-agent.",
        comments,
      };
      if (context.headSha) payload.commit_id = context.headSha;
      return payload;
    };

    try {
      const { data } = await request("POST", `${pullPath}/reviews`, reviewBody(findings.map(toComment)));
      return {
        posted: findings,
        failed: [],
        reviewId: data?.id != null ? String(data.id) : null,
      };
    } catch (error) {
      // GitHub rejects a whole review when one anchor is invalid. Retry per
      // comment so a single bad line does not lose the rest of the review.
      if (error?.status !== 422) throw error;
      logLine(`code-review-agent: batch review rejected (${error.message}); retrying one comment at a time`);
    }

    const posted = [];
    const failed = [];
    let reviewId = null;
    for (const finding of findings) {
      try {
        const { data } = await request("POST", `${pullPath}/reviews`, reviewBody([toComment(finding)]));
        posted.push(finding);
        if (data?.id != null) reviewId = String(data.id);
      } catch (error) {
        failed.push({ finding, error: error.message });
        logLine(cleanMessage(`code-review-agent: could not post inline comment at ${finding.file}:${finding.line}: ${error.message}`));
      }
    }
    return { posted, failed, reviewId };
  }

  async function resolveThread(thread) {
    const id = thread?.id;
    if (!id) throw new Error("GitHub adapter: resolveThread requires a thread id");
    await graphql(RESOLVE_THREAD_MUTATION, { id });
  }

  async function upsertSummary(body) {
    const comments = await listIssueComments();
    const own = comments.findLast(
      (comment) =>
        isBotAuthor(comment?.user?.login, botLogin) &&
        typeof comment.body === "string" &&
        comment.body.startsWith(SUMMARY_MARKER),
    );
    if (own?.id != null) {
      if (!Number.isSafeInteger(own.id)) {
        throw new GitHubApiError("GitHub adapter: summary comment id is not a safe integer", {
          method: "PATCH",
          path: `${repoPath}/issues/comments`,
        });
      }
      await request("PATCH", `${repoPath}/issues/comments/${own.id}`, { body });
      return;
    }
    await request("POST", `${issuePath}/comments`, { body });
  }

  async function setStatus(state, description = "") {
    if (state !== "success" && state !== "failure") {
      throw new Error("GitHub adapter: setStatus state must be 'success' or 'failure'");
    }
    if (!context.headSha) {
      throw new Error("GitHub adapter: HEAD_SHA (or pull_request.head.sha) is required to set a commit status");
    }
    await request("POST", `${repoPath}/statuses/${context.headSha}`, {
      state,
      context: STATUS_CONTEXT,
      description: truncateStatusDescription(description),
    });
  }

  function fileUrl(file, line) {
    const raw = typeof String.prototype.toWellFormed === "function"
      ? String(file ?? "").toWellFormed()
      : String(file ?? "");
    // Markdown link destinations break on parentheses, `?` and `#`; encode each
    // segment so the path can only ever be a path.
    const path = raw
      .replace(/\\/g, "/")
      .replace(/^(?:\.\/)+/, "")
      .split("/")
      .map((segment) =>
        encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
      )
      .join("/");
    const ref = context.headSha ?? "HEAD";
    const anchor = Number.isInteger(line) && line > 0 ? `#L${line}` : "";
    return `${serverUrl}/${owner}/${repo}/blob/${ref}/${path}${anchor}`;
  }

  return {
    name: "github",
    prLabel: "PR",
    context,
    fetchState,
    postThreads,
    resolveThread,
    upsertSummary,
    setStatus,
    fileUrl,
  };
}
