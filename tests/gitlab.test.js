import assert from "node:assert/strict";
import test from "node:test";
import { createGitLabPlatform, detectGitLab } from "../src/platforms/gitlab.js";
import { SUMMARY_MARKER, THREAD_MARKER, markdownThread } from "../src/lifecycle.js";

const token = "glpat-secret-token";
const projectId = "42";
const iid = "7";
const apiUrl = "https://gitlab.example.com/api/v4";
const projectUrl = "https://gitlab.example.com/group/repo";
const baseSha = "a".repeat(40);
const startSha = "b".repeat(40);
const headSha = "c".repeat(40);

function baseEnv(overrides = {}) {
  return {
    GITLAB_CI: "true",
    GITLAB_TOKEN: token,
    CI_API_V4_URL: apiUrl,
    CI_PROJECT_ID: projectId,
    CI_MERGE_REQUEST_IID: iid,
    CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
    CI_COMMIT_SHA: headSha,
    CI_PROJECT_URL: projectUrl,
    CI_PROJECT_DIR: "/builds/group/repo",
    ...overrides,
  };
}

const mrPath = `${apiUrl}/projects/${projectId}/merge_requests/${iid}`;

function json(status, data, headers = {}) {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Route table mock. Each handler gets the number of previous matches so a
 * route can answer differently on retries.
 */
function mockFetch(routes) {
  const calls = [];
  const counts = new Map();
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method, body, headers: init.headers ?? {}, redirect: init.redirect });
    for (const [index, route] of routes.entries()) {
      if (route.method !== method || !route.test(url)) continue;
      const n = counts.get(index) ?? 0;
      counts.set(index, n + 1);
      return route.respond(n, { url, method, body });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

const routesFor = (extra) => [
  { method: "GET", test: (url) => url === `${apiUrl}/user`, respond: () => json(200, { id: 7, username: "cra-bot" }) },
  {
    method: "GET",
    test: (url) => url === mrPath,
    respond: () => json(200, { id: 7, diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: headSha } }),
  },
  ...extra,
];

function threadBody(severity, title) {
  return [
    `**${severity} · correctness** — ${title}`,
    "",
    "description",
    "",
    "**Suggestion:**",
    "do better",
    "",
    THREAD_MARKER,
  ].join("\n");
}

function diffNote({ id, authorId, body, newPath, newLine, oldLine = null, type = "DiffNote", system = false, resolved = false, head = headSha }) {
  return {
    id,
    type,
    system,
    body,
    author: { id: authorId, username: authorId === 7 ? "cra-bot" : "someone" },
    resolved,
    position: { new_path: newPath, old_path: newPath, new_line: newLine, old_line: oldLine, head_sha: head },
  };
}

const finding = (file, line, title = "Bug here") => ({
  severity: "Warning",
  category: "correctness",
  file,
  line,
  title,
  description: "desc",
  suggestion: "fix",
});

test("detectGitLab only matches GitLab CI", () => {
  assert.equal(detectGitLab({ GITLAB_CI: "true" }), true);
  assert.equal(detectGitLab({ GITLAB_CI: "false" }), false);
  assert.equal(detectGitLab({ GITHUB_ACTIONS: "true" }), false);
  assert.equal(detectGitLab({}), false);
});

test("missing token explains that CI_JOB_TOKEN cannot write MR discussions", () => {
  assert.throws(
    () => createGitLabPlatform({ env: { GITLAB_CI: "true", CI_PROJECT_ID: projectId } }),
    (error) => {
      assert.match(error.message, /GITLAB_TOKEN/);
      assert.match(error.message, /CRA_GITLAB_TOKEN/);
      assert.match(error.message, /CI_JOB_TOKEN cannot create MR discussions/);
      assert.match(error.message, /api.*scope/);
      return true;
    },
  );
});

test("CRA_GITLAB_TOKEN is accepted as the token", () => {
  const platform = createGitLabPlatform({ env: baseEnv({ GITLAB_TOKEN: undefined, CRA_GITLAB_TOKEN: token }), fetchImpl: async () => json(200, {}) });
  assert.equal(platform.name, "gitlab");
  assert.equal(platform.prLabel, "MR");
});

test("non merge-request pipeline fails with a rules hint", () => {
  const env = baseEnv({ CI_MERGE_REQUEST_IID: undefined });
  assert.throws(() => createGitLabPlatform({ env, fetchImpl: async () => json(200, {}) }), (error) => {
    assert.match(error.message, /merge-request pipeline/);
    assert.match(error.message, /CI_MERGE_REQUEST_IID/);
    assert.match(error.message, /merge_request_event/);
    return true;
  });
});

test("context resolves from GitLab env with PR_NUMBER/BASE_SHA/HEAD_SHA overrides", () => {
  const env = baseEnv({ PR_NUMBER: "99", BASE_SHA: "d".repeat(40), HEAD_SHA: "e".repeat(40) });
  const platform = createGitLabPlatform({ env, fetchImpl: async () => json(200, {}) });
  assert.deepEqual(platform.context, {
    prNumber: "99",
    baseSha: "d".repeat(40),
    headSha: "e".repeat(40),
    workspace: "/builds/group/repo",
  });
});

test("fetchState filters foreign, system and non-marker notes and paginates", async () => {
  const page1 = [
    { id: "d1", notes: [diffNote({ id: 11, authorId: 7, body: threadBody("Critical", "SQL injection"), newPath: "src/db.js", newLine: 12, resolved: true })] },
    { id: "d2", notes: [diffNote({ id: 12, authorId: 8, body: threadBody("Warning", "Foreign bot"), newPath: "src/x.js", newLine: 5 })] },
    { id: "d3", notes: [diffNote({ id: 13, authorId: 7, body: "System note: changed the description", newPath: "src/y.js", newLine: 6, system: true })] },
    { id: "d4", notes: [diffNote({ id: 14, authorId: 7, body: "just a human comment", newPath: "src/z.js", newLine: 7 })] },
    { id: "d5", notes: [diffNote({ id: 15, authorId: 7, body: "not a diff note", newPath: "src/w.js", newLine: 8, type: "Note" })] },
  ];
  const page2 = [
    { id: "d6", notes: [diffNote({ id: 16, authorId: 7, body: threadBody("Info", "Context anchor"), newPath: "src/ctx.js", newLine: null, oldLine: 41 })] },
  ];
  const summaryBody = `${SUMMARY_MARKER}\nReviewed <!-- code-review-agent:reviewed-sha=${headSha} -->`;
  const notes = [
    { id: 21, system: false, author: { id: 8 }, body: "other summary" },
    { id: 22, system: true, author: { id: 7 }, body: `${SUMMARY_MARKER}\nbot system note` },
    { id: 23, system: false, author: { id: 7 }, body: "unrelated bot note" },
    { id: 24, system: false, author: { id: 7 }, body: summaryBody },
  ];

  const { fetchImpl, calls } = mockFetch(
    routesFor([
      {
        method: "GET",
        test: (url) => url === `${mrPath}/discussions?per_page=100&page=1`,
        respond: () => json(200, page1, { "x-next-page": "2" }),
      },
      {
        method: "GET",
        test: (url) => url === `${mrPath}/discussions?per_page=100&page=2`,
        respond: () => json(200, page2, { "x-next-page": "" }),
      },
      {
        method: "GET",
        test: (url) => url === `${mrPath}/notes?sort=desc&per_page=100&page=1`,
        respond: () => json(200, notes, { "x-next-page": "" }),
      },
    ]),
  );

  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  const state = await platform.fetchState();

  assert.equal(state.threads.length, 2);
  assert.deepEqual(state.threads[0], {
    id: "d1",
    key: "src/db.js:12:sql injection",
    path: "src/db.js",
    line: 12,
    title: "SQL injection",
    severity: "Critical",
    isResolved: true,
    isOutdated: false,
  });
  assert.deepEqual(
    { id: state.threads[1].id, path: state.threads[1].path, line: state.threads[1].line, severity: state.threads[1].severity, title: state.threads[1].title },
    { id: "d6", path: "src/ctx.js", line: 41, severity: "Info", title: "Context anchor" },
  );
  assert.equal(state.lastReviewedSha, headSha);

  const discussionPages = calls.filter((call) => call.url.includes("/discussions")).map((call) => call.url);
  assert.deepEqual(discussionPages, [`${mrPath}/discussions?per_page=100&page=1`, `${mrPath}/discussions?per_page=100&page=2`]);
  for (const call of calls) {
    assert.equal(call.headers["PRIVATE-TOKEN"], token);
    assert.ok(!call.url.includes(token), "token must never appear in a URL");
  }
});

test("identity and diff_refs are fetched once and reused", async () => {
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      { method: "GET", test: (url) => url === `${mrPath}/discussions?per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
      { method: "GET", test: (url) => url === `${mrPath}/notes?sort=desc&per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  const first = await platform.fetchState();
  const second = await platform.fetchState();
  assert.deepEqual(first, { threads: [], lastReviewedSha: null });
  assert.deepEqual(second, first);
  const count = (fragment) => calls.filter((call) => call.url === fragment).length;
  assert.equal(count(`${apiUrl}/user`), 1);
  assert.equal(count(mrPath), 1);
});

test("postThreads uses diff_refs positions and reports a single-item failure", async () => {
  const added = finding("src/added.js", 10, "Added line bug");
  const context = finding("src/ctx.js", 42, "Context line bug");
  const failedFinding = finding("src/renamed.js", 3, "Bad anchor");

  const { fetchImpl, calls } = mockFetch(
    routesFor([
      {
        method: "POST",
        test: (url) => url === `${mrPath}/discussions`,
        respond: (_n, { body }) => {
          if (body.position.new_path === "src/renamed.js") {
            return json(400, { message: { position: ["line_code can't be blank"] } });
          }
          return json(201, { id: "new-discussion" });
        },
      },
    ]),
  );

  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  const result = await platform.postThreads([
    { finding: added, anchor: { type: "add", oldLine: null } },
    { finding: context, anchor: { type: "context", oldLine: 41 } },
    { finding: failedFinding, anchor: { type: "add", oldLine: null, oldPath: "src/old-name.js" } },
  ]);

  assert.equal(result.reviewId, null);
  assert.deepEqual(result.posted, [added, context]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].finding, failedFinding);
  assert.match(result.failed[0].error, /400/);
  assert.match(result.failed[0].error, /line_code can't be blank/);

  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 3);
  for (const post of posts) assert.equal(post.headers["PRIVATE-TOKEN"], token);

  const addedPost = posts.find((call) => call.body.position.new_path === "src/added.js");
  assert.equal(addedPost.body.body, markdownThread(added));
  assert.deepEqual(addedPost.body.position, {
    position_type: "text",
    base_sha: baseSha,
    start_sha: startSha,
    head_sha: headSha,
    new_path: "src/added.js",
    old_path: "src/added.js",
    new_line: 10,
  });
  assert.ok(!("old_line" in addedPost.body.position), "added lines must not carry old_line");

  const contextPost = posts.find((call) => call.body.position.new_path === "src/ctx.js");
  assert.equal(contextPost.body.position.new_line, 42);
  assert.equal(contextPost.body.position.old_line, 41);

  const renamePost = posts.find((call) => call.body.position.new_path === "src/renamed.js");
  assert.equal(renamePost.body.position.old_path, "src/old-name.js");
});

test("resolveThread sends PUT with resolved=true", async () => {
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      { method: "PUT", test: (url) => url === `${mrPath}/discussions/abc123?resolved=true`, respond: () => json(200, { id: "abc123" }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  await platform.resolveThread({ id: "abc123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].url, `${mrPath}/discussions/abc123?resolved=true`);
});

test("resolveThread throws the GitLab error", async () => {
  const { fetchImpl } = mockFetch(
    routesFor([
      { method: "PUT", test: (url) => url.includes("/discussions/missing"), respond: () => json(404, { message: "404 Not found" }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  await assert.rejects(platform.resolveThread({ id: "missing" }), /PUT .* 404 404 Not found/);
});

test("upsertSummary creates a note when the bot has no summary", async () => {
  const body = `${SUMMARY_MARKER}\nreviewed`;
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      { method: "GET", test: (url) => url === `${mrPath}/notes?sort=desc&per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
      { method: "POST", test: (url) => url === `${mrPath}/notes`, respond: () => json(201, { id: 555 }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  await platform.upsertSummary(body);
  const writes = calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].url, `${mrPath}/notes`);
  assert.equal(writes[0].body.body, body);
});

test("upsertSummary edits the bot's own existing summary", async () => {
  const body = `${SUMMARY_MARKER}\nreviewed again`;
  const notes = [
    { id: 21, system: false, author: { id: 8 }, body: `${SUMMARY_MARKER}\nforeign` },
    { id: 99, system: false, author: { id: 7 }, body: `${SUMMARY_MARKER}\nold` },
  ];
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      { method: "GET", test: (url) => url === `${mrPath}/notes?sort=desc&per_page=100&page=1`, respond: () => json(200, notes, { "x-next-page": "" }) },
      { method: "PUT", test: (url) => url === `${mrPath}/notes/99`, respond: () => json(200, { id: 99 }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  await platform.upsertSummary(body);
  const writes = calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.equal(writes[0].url, `${mrPath}/notes/99`);
  assert.equal(writes[0].body.body, body);
});

test("setStatus maps failure to failed and names the check", async () => {
  const statusUrl = `${apiUrl}/projects/${projectId}/statuses/${headSha}`;
  const { fetchImpl, calls } = mockFetch(
    routesFor([{ method: "POST", test: (url) => url === statusUrl, respond: () => json(201, { id: 1 }) }]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  await platform.setStatus("failure", "2 blocking findings");
  await platform.setStatus("success", "clean");
  assert.equal(calls[0].body.state, "failed");
  assert.equal(calls[0].body.name, "code-review-agent");
  assert.equal(calls[0].body.description, "2 blocking findings");
  assert.equal(calls[1].body.state, "success");
});

test("fileUrl points at the head blob line", () => {
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl: async () => json(200, {}) });
  assert.equal(
    platform.fileUrl("src/a b.js", 9),
    `${projectUrl}/-/blob/${headSha}/src/a%20b.js#L9`,
  );
});

test("retries a 503 and then succeeds", async () => {
  const logs = [];
  const { fetchImpl, calls } = mockFetch([
    {
      method: "GET",
      test: (url) => url === `${apiUrl}/user`,
      respond: (n) => (n === 0 ? json(503, { message: "busy" }, { "retry-after": "0" }) : json(200, { id: 7 })),
    },
    { method: "GET", test: (url) => url === mrPath, respond: () => json(200, { diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: headSha } }) },
    { method: "GET", test: (url) => url === `${mrPath}/discussions?per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
    { method: "GET", test: (url) => url === `${mrPath}/notes?sort=desc&per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
  ]);
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl, log: (line) => logs.push(line) });
  const state = await platform.fetchState();
  assert.deepEqual(state.threads, []);
  assert.equal(calls.filter((call) => call.url === `${apiUrl}/user`).length, 2);
  assert.ok(logs.some((line) => /retrying HTTP 503/.test(line)));
});

test("retries when the body read fails after the headers", async () => {
  const logs = [];
  const { fetchImpl, calls } = mockFetch([
    {
      method: "GET",
      test: (url) => url === `${apiUrl}/user`,
      respond: (n) => (n === 0
        ? { ok: true, status: 200, headers: new Headers(), text: () => Promise.reject(new Error("socket hang up")) }
        : json(200, { id: 7 })),
    },
    { method: "GET", test: (url) => url === mrPath, respond: () => json(200, { diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: headSha } }) },
    { method: "GET", test: (url) => url === `${mrPath}/discussions?per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
    { method: "GET", test: (url) => url === `${mrPath}/notes?sort=desc&per_page=100&page=1`, respond: () => json(200, [], { "x-next-page": "" }) },
  ]);
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl, log: (line) => logs.push(line) });
  const state = await platform.fetchState();
  assert.deepEqual(state, { threads: [], lastReviewedSha: null });
  assert.equal(calls.filter((call) => call.url === `${apiUrl}/user`).length, 2);
  assert.ok(logs.some((line) => /retrying network error/.test(line)));
});

test("gives up on a persistent body-read failure with a contextual error", async () => {
  const unreadable = () => ({ ok: true, status: 200, headers: new Headers(), text: () => Promise.reject(new Error(`boom ${token}`)) });
  const { fetchImpl, calls } = mockFetch([
    { method: "POST", test: (url) => url === `${apiUrl}/projects/${projectId}/statuses/${headSha}`, respond: unreadable },
  ]);
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl, log: () => {} });
  await assert.rejects(platform.setStatus("success", "x"), (error) => {
    assert.match(error.message, /^POST \/projects\/42\/statuses\/c+: network error: boom \[REDACTED\]$/);
    return true;
  });
  assert.equal(calls.length, 4, "one attempt plus three retries");
});

test("does not retry a 4xx and includes method, path, status and message", async () => {
  const statusUrl = `${apiUrl}/projects/${projectId}/statuses/${headSha}`;
  const { fetchImpl, calls } = mockFetch([
    { method: "POST", test: (url) => url === statusUrl, respond: () => json(422, { message: "description is too long" }) },
  ]);
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  await assert.rejects(platform.setStatus("failure", "x"), (error) => {
    assert.match(error.message, /^POST \/projects\/42\/statuses\/c+: 422 description is too long$/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Reviewed head vs MR diff_refs, redirects, fileUrl
// ---------------------------------------------------------------------------

const reviewedSha = "d".repeat(40);
const versionBase = "e".repeat(40);
const versionStart = "f".repeat(40);

const versionsUrl = `${mrPath}/versions?per_page=100&page=1`;

test("postThreads uses the MR version whose head is the reviewed head", async () => {
  const added = finding("src/added.js", 10, "Added line bug");
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      {
        method: "GET",
        test: (url) => url === versionsUrl,
        respond: () => json(
          200,
          [
            { id: 1, head_commit_sha: headSha, base_commit_sha: baseSha, start_commit_sha: startSha },
            { id: 2, head_commit_sha: reviewedSha, base_commit_sha: versionBase, start_commit_sha: versionStart },
          ],
          { "x-next-page": "" },
        ),
      },
      { method: "POST", test: (url) => url === `${mrPath}/discussions`, respond: () => json(201, { id: "new" }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  // The CLI rewrites the reviewed SHA after the adapter is created.
  platform.context.headSha = reviewedSha;

  const result = await platform.postThreads([{ finding: added, anchor: { type: "add", oldLine: null } }]);

  assert.deepEqual(result.posted, [added]);
  assert.deepEqual(result.failed, []);
  const post = calls.find((call) => call.method === "POST");
  assert.equal(post.body.position.head_sha, reviewedSha);
  assert.equal(post.body.position.base_sha, versionBase);
  assert.equal(post.body.position.start_sha, versionStart);

  const order = calls.map((call) => call.url);
  assert.ok(order.indexOf(versionsUrl) < order.indexOf(`${mrPath}/discussions`), "versions resolve before posting");
});

test("postThreads fails every item when no MR version matches the reviewed head", async () => {
  const first = finding("src/a.js", 4, "First");
  const second = finding("src/b.js", 9, "Second");
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      {
        method: "GET",
        test: (url) => url === versionsUrl,
        respond: () => json(
          200,
          [{ id: 1, head_commit_sha: headSha, base_commit_sha: baseSha, start_commit_sha: startSha }],
          { "x-next-page": "" },
        ),
      },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  platform.context.headSha = reviewedSha;

  const result = await platform.postThreads([
    { finding: first, anchor: { type: "add", oldLine: null } },
    { finding: second, anchor: { type: "add", oldLine: null } },
  ]);

  assert.deepEqual(result.posted, []);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(result.failed.map((entry) => entry.finding), [first, second]);
  for (const entry of result.failed) {
    assert.match(entry.error, /no MR version has head_commit_sha/);
    assert.ok(entry.error.includes(reviewedSha));
    assert.ok(!entry.error.includes(token));
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 0, "nothing may be posted under the wrong refs");
});

test("postThreads resolves the version refs once for repeated posts", async () => {
  const first = finding("src/a.js", 4, "First");
  const second = finding("src/b.js", 9, "Second");
  const { fetchImpl, calls } = mockFetch(
    routesFor([
      {
        method: "GET",
        test: (url) => url === versionsUrl,
        respond: () => json(
          200,
          [{ id: 2, head_commit_sha: reviewedSha, base_commit_sha: versionBase, start_commit_sha: versionStart }],
          { "x-next-page": "" },
        ),
      },
      { method: "POST", test: (url) => url === `${mrPath}/discussions`, respond: () => json(201, { id: "new" }) },
    ]),
  );
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl });
  platform.context.headSha = reviewedSha;

  await platform.postThreads([{ finding: first, anchor: null }]);
  await platform.postThreads([{ finding: second, anchor: null }]);

  assert.equal(calls.filter((call) => call.url === versionsUrl).length, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
});

test("a 3xx response is an error and the request never follows it", async () => {
  const statusUrl = `${apiUrl}/projects/${projectId}/statuses/${headSha}`;
  const { fetchImpl, calls } = mockFetch([
    {
      method: "POST",
      test: (url) => url === statusUrl,
      respond: () => json(302, null, { location: "https://evil.example/steal" }),
    },
  ]);
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl, log: () => {} });

  await assert.rejects(platform.setStatus("success", "ok"), /302 unexpected redirect to https:\/\/evil\.example\/steal/);

  assert.equal(calls.length, 1, "a redirect is not retried");
  assert.equal(calls[0].redirect, "manual", "redirects must never be followed with the token attached");
  assert.equal(calls[0].headers["PRIVATE-TOKEN"], token);
});

test("fileUrl encodes reserved characters in every path segment", () => {
  const platform = createGitLabPlatform({ env: baseEnv(), fetchImpl: async () => json(200, {}) });
  const blob = `${projectUrl}/-/blob/${headSha}`;
  assert.equal(platform.fileUrl("src/a b#c?d.js", 3), `${blob}/src/a%20b%23c%3Fd.js#L3`);
  assert.equal(platform.fileUrl("src/a (b).js"), `${blob}/src/a%20%28b%29.js`);
  assert.equal(platform.fileUrl("./src/deep/x.js"), `${blob}/src/deep/x.js`);
  assert.equal(platform.fileUrl("src/100%done.js"), `${blob}/src/100%25done.js`);

  const trailing = createGitLabPlatform({
    env: baseEnv({ CI_PROJECT_URL: `${projectUrl}/` }),
    fetchImpl: async () => json(200, {}),
  });
  assert.equal(trailing.fileUrl("src/x.js", 1), `${blob}/src/x.js#L1`);
});
