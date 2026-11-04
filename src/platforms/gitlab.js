import {
  SUMMARY_MARKER,
  isOwnThreadBody,
  markdownThread,
  parseReviewedSha,
  parseThreadBody,
  threadKey,
} from "../lifecycle.js";

export function detectGitLab(env = process.env) {
  return env.GITLAB_CI === "true";
}

/**
 * Percent-encode a repo-relative path segment by segment so a file name cannot
 * escape the blob path or break a Markdown link (`#`, `?`, spaces, parentheses).
 */
function encodePath(file) {
  const raw = typeof String.prototype.toWellFormed === "function"
    ? String(file ?? "").toWellFormed()
    : String(file ?? "");
  return raw
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export function createGitLabPlatform({ env = process.env, fetchImpl = globalThis.fetch, log = console.error } = {}) {
  const token = env.GITLAB_TOKEN || env.CRA_GITLAB_TOKEN;
  if (!token) {
    throw new Error("GitLab requires GITLAB_TOKEN or CRA_GITLAB_TOKEN. CI_JOB_TOKEN cannot create MR discussions; use a project/group access token or personal access token with api scope.");
  }
  const context = {
    prNumber: env.PR_NUMBER || env.CI_MERGE_REQUEST_IID,
    baseSha: env.BASE_SHA || env.CI_MERGE_REQUEST_DIFF_BASE_SHA,
    // Merged-results pipelines run on a temporary merge commit (CI_COMMIT_SHA);
    // MR positions must reference the source branch head instead.
    headSha: env.HEAD_SHA || env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA,
    workspace: env.CI_PROJECT_DIR,
  };
  if (!context.prNumber) {
    throw new Error("GitLab review requires a merge-request pipeline (CI_MERGE_REQUEST_IID or PR_NUMBER). Configure rules: - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
  }
  for (const [name, value] of [
    ["CI_PROJECT_ID", env.CI_PROJECT_ID],
    ["BASE_SHA or CI_MERGE_REQUEST_DIFF_BASE_SHA", context.baseSha],
    ["HEAD_SHA or CI_COMMIT_SHA", context.headSha],
    ["CI_PROJECT_DIR", context.workspace],
    ["CI_PROJECT_URL", env.CI_PROJECT_URL],
  ]) {
    if (!value) throw new Error(`GitLab review requires ${name}.`);
  }
  const apiUrl = (env.CI_API_V4_URL || "https://gitlab.com/api/v4").replace(/\/+$/, "");
  const serverUrl = env.CI_PROJECT_URL.replace(/\/+$/, "");
  const projectPath = `/projects/${encodeURIComponent(env.CI_PROJECT_ID)}`;
  const mrPath = `${projectPath}/merge_requests/${encodeURIComponent(context.prNumber)}`;
  const redact = (value) => String(value).replaceAll(token, "[REDACTED]");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let response;
      let text;
      try {
        response = await fetchImpl(`${apiUrl}${path}`, {
          method,
          headers: { "PRIVATE-TOKEN": token, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // Never follow a redirect: the PRIVATE-TOKEN header must only reach
          // the configured API host. A 3xx is a hard error, not a retry.
          redirect: "manual",
        });
        // Read the body inside the retry boundary: a connection drop after the
        // headers still rejects here and must be retried/redacted like any
        // other network error.
        text = await response.text();
      } catch (error) {
        if (attempt >= 3) throw new Error(`${method} ${path}: network error: ${redact(error.message ?? error)}`);
        log(`GitLab ${method} ${path}: retrying network error (${attempt + 1}/3)`);
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        const where = location
          ? ` to ${redact(String(location).replace(/[\u0000-\u001f\u007f]+/g, " "))}`
          : "";
        throw new Error(`${method} ${path}: ${response.status} unexpected redirect${where}`);
      }
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (response.ok) return { data, headers: response.headers };
      const message = typeof data === "object" && data !== null ? data.message ?? data.error ?? data : data;
      const error = new Error(`${method} ${path}: ${response.status} ${redact(typeof message === "string" ? message : JSON.stringify(message))}`);
      if (attempt >= 3 || (response.status !== 429 && response.status < 500)) throw error;
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null || retryAfter.trim() === "" ? NaN : Number(retryAfter);
      const date = retryAfter === null ? NaN : Date.parse(retryAfter);
      const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
        : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 250 * 2 ** attempt;
      log(`GitLab ${method} ${path}: retrying HTTP ${response.status} (${attempt + 1}/3)`);
      await sleep(delay);
    }
  }

  async function list(path) {
    const items = [];
    const seen = new Set();
    let page = "1";
    while (page) {
      if (seen.has(page) || !/^\d+$/.test(page)) throw new Error(`GET ${path}: invalid GitLab x-next-page pagination`);
      seen.add(page);
      const separator = path.includes("?") ? "&" : "?";
      const { data, headers } = await request("GET", `${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error(`GET ${path}: expected a GitLab list response`);
      items.push(...data);
      page = headers.get("x-next-page")?.trim() || "";
    }
    return items;
  }

  let userPromise;
  let refsPromise;
  let positionRefs;
  let summaryId;
  const getUser = () => userPromise ??= request("GET", "/user").then(({ data }) => {
    if (data?.id == null) throw new Error("GET /user: GitLab response is missing the bot user id");
    return data;
  });
  const getRefs = () => refsPromise ??= request("GET", mrPath).then(({ data }) => {
    const refs = data?.diff_refs;
    if (!refs?.base_sha || !refs.start_sha || !refs.head_sha) throw new Error(`GET ${mrPath}: GitLab response is missing diff_refs`);
    return refs;
  });

  /**
   * Diff refs for the reviewed head. `context.headSha` is read here, not when
   * the adapter is created: the CLI rewrites it to the SHA it actually
   * reviewed. The MR's `diff_refs` may already point at a newer head, in which
   * case the matching MR version supplies base/start/head for that SHA.
   * Throws when no version matches, so nothing is posted under the wrong refs.
   */
  async function getPositionRefs() {
    const headSha = context.headSha;
    if (positionRefs?.headSha === headSha) return positionRefs.refs;
    const current = await getRefs();
    let refs = current;
    if (headSha !== current.head_sha) {
      const versions = await list(`${mrPath}/versions`);
      const match = versions.find((version) => version?.head_commit_sha === headSha);
      if (!match?.base_commit_sha || !match.start_commit_sha || !match.head_commit_sha) {
        throw new Error(
          `no MR version has head_commit_sha ${headSha} (MR diff_refs head is ${current.head_sha}); refusing to post discussions under the wrong diff refs`,
        );
      }
      refs = { base_sha: match.base_commit_sha, start_sha: match.start_commit_sha, head_sha: match.head_commit_sha };
    }
    positionRefs = { headSha, refs };
    return refs;
  }

  async function loadSummary(user) {
    const notes = await list(`${mrPath}/notes?sort=desc`);
    const summary = notes.find((note) => !note.system && note.author?.id === user.id
      && typeof note.body === "string" && note.body.startsWith(SUMMARY_MARKER));
    summaryId = summary?.id ?? null;
    return summary ? parseReviewedSha(summary.body) : null;
  }

  return {
    name: "gitlab",
    prLabel: "MR",
    context,
    async fetchState() {
      const [user] = await Promise.all([getUser(), getRefs()]);
      const discussions = await list(`${mrPath}/discussions`);
      const threads = [];
      for (const discussion of discussions) {
        const note = discussion.notes?.[0];
        if (!note || note.type !== "DiffNote" || note.system || note.author?.id !== user.id || !isOwnThreadBody(note.body)) continue;
        const path = note.position?.new_path;
        if (!path) continue;
        const line = note.position.new_line ?? note.position.old_line ?? 0;
        const { title, severity } = parseThreadBody(note.body);
        threads.push({
          id: discussion.id,
          key: threadKey({ file: path, line, title }),
          path, line, title, severity,
          isResolved: Boolean(note.resolved),
          // GitLab exposes no reliable outdated flag; the CLI resolves by changed files instead.
          isOutdated: false,
        });
      }
      return { threads, lastReviewedSha: await loadSummary(user) };
    },
    async postThreads(items) {
      const posted = [];
      const failed = [];
      if (!items?.length) return { posted, failed, reviewId: null };
      let refs;
      try {
        // Resolve once up front: if the reviewed head has no MR version, every
        // finding fails with that reason and no discussion is created.
        refs = await getPositionRefs();
      } catch (error) {
        const reason = redact(error.message ?? error);
        for (const { finding } of items) failed.push({ finding, error: reason });
        return { posted, failed, reviewId: null };
      }
      for (const { finding, anchor } of items) {
        try {
          await request("POST", `${mrPath}/discussions`, {
            body: markdownThread(finding),
            position: {
              position_type: "text",
              base_sha: refs.base_sha,
              start_sha: refs.start_sha,
              head_sha: refs.head_sha,
              new_path: finding.file,
              old_path: anchor?.oldPath ?? finding.file,
              new_line: finding.line,
              ...(anchor?.type === "context" ? { old_line: anchor.oldLine } : {}),
            },
          });
          posted.push(finding);
        } catch (error) {
          failed.push({ finding, error: redact(error.message ?? error) });
        }
      }
      return { posted, failed, reviewId: null };
    },
    async resolveThread(thread) {
      await request("PUT", `${mrPath}/discussions/${encodeURIComponent(thread.id)}?resolved=true`);
    },
    async upsertSummary(body) {
      if (summaryId === undefined) await loadSummary(await getUser());
      if (summaryId != null) {
        await request("PUT", `${mrPath}/notes/${encodeURIComponent(summaryId)}`, { body });
      } else {
        const { data } = await request("POST", `${mrPath}/notes`, { body });
        summaryId = data?.id;
      }
    },
    async setStatus(state, description) {
      await request("POST", `${projectPath}/statuses/${encodeURIComponent(context.headSha)}`, {
        state: state === "failure" ? "failed" : state,
        name: "code-review-agent",
        description,
      });
    },
    fileUrl(file, line) {
      const anchor = Number.isInteger(line) && line > 0 ? `#L${line}` : "";
      return `${serverUrl}/-/blob/${context.headSha}/${encodePath(file)}${anchor}`;
    },
  };
}
