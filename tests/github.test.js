import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitHubApiError,
  createGitHubPlatform,
  detectGitHub,
  isBotAuthor,
} from "../src/platforms/github.js";
import { SUMMARY_MARKER, markdownSummary, markdownThread, threadKey } from "../src/lifecycle.js";

const TOKEN = "ghp_SECRET123";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

const BASE_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "acme/widgets",
  PR_NUMBER: "7",
  BASE_SHA,
  HEAD_SHA,
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = body === undefined || body === null ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makePlatform(handler, { env = {}, sleep, retryBaseMs } = {}) {
  const fetchImpl = mockFetch(handler);
  const delays = [];
  const sleepImpl =
    sleep ??
    (async (ms) => {
      delays.push(ms);
    });
  const platform = createGitHubPlatform({
    env: { ...BASE_ENV, ...env },
    fetchImpl,
    log: () => {},
    sleep: sleepImpl,
    ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
  });
  return { platform, fetchImpl, calls: fetchImpl.calls, delays };
}

const finding = (overrides = {}) => ({
  severity: "Critical",
  category: "security",
  file: "src/a.js",
  line: 10,
  title: "SQL injection",
  description: "User input reaches the query.",
  suggestion: "Use a parameterized query.",
  ...overrides,
});

const commentAuthor = (login) => ({ user: { login } });

// ---------------------------------------------------------------------------
// Identity + detection
// ---------------------------------------------------------------------------

test("detectGitHub only matches GITHUB_ACTIONS === 'true'", () => {
  assert.equal(detectGitHub({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(detectGitHub({ GITHUB_ACTIONS: "false" }), false);
  assert.equal(detectGitHub({}), false);
  assert.equal(detectGitHub(undefined), false);
});

test("isBotAuthor accepts both github-actions spellings and rejects others", () => {
  for (const botLogin of ["github-actions", "github-actions[bot]"]) {
    assert.equal(isBotAuthor("github-actions", botLogin), true);
    assert.equal(isBotAuthor("github-actions[bot]", botLogin), true);
    assert.equal(isBotAuthor("alice", botLogin), false);
    assert.equal(isBotAuthor(undefined, botLogin), false);
  }
  assert.equal(isBotAuthor("release-bot", "release-bot"), true);
  assert.equal(isBotAuthor("release-bot", "github-actions"), false);
});

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

function writeEventFile(pull) {
  const dir = mkdtempSync(join(tmpdir(), "cra-github-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify({ pull_request: pull }));
  return path;
}

test("context comes from GITHUB_EVENT_PATH when overrides are absent", () => {
  const eventPath = writeEventFile({
    number: 42,
    base: { sha: "1a2b3c4" },
    head: { sha: "5d6e7f8" },
  });
  const { platform } = makePlatform(() => jsonResponse({}), {
    env: {
      GITHUB_EVENT_PATH: eventPath,
      PR_NUMBER: "",
      BASE_SHA: "",
      HEAD_SHA: "",
      GITHUB_WORKSPACE: "/tmp/workspace",
    },
  });

  assert.deepEqual(platform.context, {
    prNumber: 42,
    baseSha: "1a2b3c4",
    headSha: "5d6e7f8",
    workspace: "/tmp/workspace",
  });
});

test("PR_NUMBER/BASE_SHA/HEAD_SHA override the event file", () => {
  const eventPath = writeEventFile({
    number: 42,
    base: { sha: "1a2b3c4" },
    head: { sha: "5d6e7f8" },
  });
  const { platform } = makePlatform(() => jsonResponse({}), {
    env: {
      GITHUB_EVENT_PATH: eventPath,
      PR_NUMBER: "43",
      BASE_SHA: "1111111",
      HEAD_SHA: "2222222",
    },
  });

  assert.deepEqual(platform.context, {
    prNumber: 43,
    baseSha: "1111111",
    headSha: "2222222",
    workspace: process.cwd(),
  });
});

test("missing token throws a clear error; CRA_GITHUB_TOKEN is a fallback", () => {
  assert.throws(
    () => makePlatform(() => jsonResponse({}), { env: { GITHUB_TOKEN: undefined, CRA_GITHUB_TOKEN: undefined } }),
    /GITHUB_TOKEN or CRA_GITHUB_TOKEN/,
  );
  const { platform } = makePlatform(() => jsonResponse({}), {
    env: { GITHUB_TOKEN: undefined, CRA_GITHUB_TOKEN: "cra-token" },
  });
  assert.equal(platform.context.prNumber, 7);
});

test("missing repository or PR number throws clear errors", () => {
  assert.throws(() => makePlatform(() => jsonResponse({}), { env: { GITHUB_REPOSITORY: "widgets" } }), /GITHUB_REPOSITORY/);
  assert.throws(() => makePlatform(() => jsonResponse({}), { env: { PR_NUMBER: "" } }), /pull request number/);
});

test("rejects dot-segment repository parts", () => {
  assert.throws(() => makePlatform(() => jsonResponse({}), { env: { GITHUB_REPOSITORY: "../x" } }), /GITHUB_REPOSITORY/);
  assert.throws(() => makePlatform(() => jsonResponse({}), { env: { GITHUB_REPOSITORY: "acme/.." } }), /GITHUB_REPOSITORY/);
});

test("rejects non-hex SHAs that would be interpolated into URL paths", () => {
  assert.throws(() => makePlatform(() => jsonResponse({}), { env: { HEAD_SHA: "abc/../../x" } }), /hex SHA/);
  assert.throws(() => makePlatform(() => jsonResponse({}), { env: { BASE_SHA: "main" } }), /hex SHA/);
});

test("rejects a token that cannot be sent as an HTTP header", () => {
  assert.throws(
    () => makePlatform(() => jsonResponse({}), { env: { GITHUB_TOKEN: "bad\ntoken" } }),
    /token contains characters/,
  );
});

// ---------------------------------------------------------------------------
// fetchState
// ---------------------------------------------------------------------------

test("fetchState paginates threads, filters bot/marker, parses severity, and reads the bot summary SHA", async () => {
  const threadA = finding();
  const threadB = finding({ severity: "Warning", category: "bug", file: "src/b.js", line: 21, title: "Connection leak" });
  const botBody = markdownThread(threadA);
  const warnedBody = markdownThread(threadB);
  const humanSummary = markdownSummary({
    summary: "human note",
    findings: [],
    headSha: "deadbeef",
    prNumber: 7,
    unresolvedCount: 0,
  });
  const botSummary = markdownSummary({
    summary: "automated",
    findings: [threadB],
    headSha: "abc1234",
    prNumber: 7,
    unresolvedCount: 1,
  });

  const graphqlCalls = [];
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      graphqlCalls.push(call.body);
      if (!call.body.variables.cursor) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                  nodes: [
                    {
                      id: "T1",
                      path: "src/a.js",
                      line: 10,
                      originalLine: 8,
                      isResolved: false,
                      isOutdated: false,
                      comments: { nodes: [{ author: { login: "github-actions[bot]" }, body: botBody }] },
                    },
                    {
                      id: "T-human",
                      path: "src/a.js",
                      line: 11,
                      originalLine: 11,
                      isResolved: false,
                      isOutdated: false,
                      comments: { nodes: [{ author: { login: "alice" }, body: botBody }] },
                    },
                    {
                      id: "T-nomarker",
                      path: "src/a.js",
                      line: 12,
                      originalLine: 12,
                      isResolved: false,
                      isOutdated: false,
                      comments: { nodes: [{ author: { login: "github-actions" }, body: "just a note" }] },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T2",
                    path: "src/b.js",
                    line: null,
                    originalLine: 21,
                    isResolved: true,
                    isOutdated: true,
                    comments: { nodes: [{ author: { login: "github-actions" }, body: warnedBody }] },
                  },
                ],
              },
            },
          },
        },
      });
    }

    const url = new URL(call.url);
    if (url.searchParams.get("page") === "2") {
      return jsonResponse([{ id: 22, ...commentAuthor("github-actions[bot]"), body: botSummary }]);
    }
    return jsonResponse(
      [
        { id: 11, ...commentAuthor("alice"), body: humanSummary },
        { id: 12, ...commentAuthor("github-actions"), body: "thanks for the review" },
      ],
      {
        headers: {
          link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=2>; rel="next"',
        },
      },
    );
  });

  const state = await platform.fetchState();

  assert.equal(graphqlCalls.length, 2);
  assert.deepEqual(graphqlCalls[0].variables, { owner: "acme", name: "widgets", number: 7, cursor: null });
  assert.deepEqual(graphqlCalls[1].variables, { owner: "acme", name: "widgets", number: 7, cursor: "cursor-2" });
  assert.match(graphqlCalls[0].query, /reviewThreads\(first: 100/);
  assert.match(graphqlCalls[0].query, /comments\(first: 1\)/);

  assert.equal(state.threads.length, 2);
  assert.deepEqual(state.threads[0], {
    id: "T1",
    key: threadKey({ file: "src/a.js", line: 10, title: "SQL injection" }),
    path: "src/a.js",
    line: 10,
    title: "SQL injection",
    severity: "Critical",
    isResolved: false,
    isOutdated: false,
  });
  assert.equal(state.threads[1].id, "T2");
  assert.equal(state.threads[1].line, 21);
  assert.equal(state.threads[1].severity, "Warning");
  assert.equal(state.threads[1].isResolved, true);
  assert.equal(state.threads[1].isOutdated, true);

  // The human comment starts with the marker but must not count as our summary.
  assert.equal(state.lastReviewedSha, "abc1234");
});

test("GraphQL errors array throws instead of returning empty state", async () => {
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: null,
        errors: [{ message: "Could not resolve to a PullRequest with the number of 7." }],
      });
    }
    return jsonResponse([]);
  });

  await assert.rejects(platform.fetchState(), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.match(error.message, /GraphQL/);
    assert.match(error.message, /Could not resolve to a PullRequest/);
    return true;
  });
});

test("paginates review threads past 100 pages instead of truncating", async () => {
  const pageCount = 120;
  const { platform, calls } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      const cursor = call.body.variables.cursor;
      const page = cursor === null ? 1 : Number(cursor.slice(1));
      const f = finding({ file: `src/f${page}.js`, line: page, title: `Issue ${page}` });
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: page < pageCount, endCursor: page < pageCount ? `c${page + 1}` : null },
                nodes: [
                  {
                    id: `T${page}`,
                    path: f.file,
                    line: f.line,
                    originalLine: null,
                    isResolved: false,
                    isOutdated: false,
                    comments: { nodes: [{ author: { login: "github-actions" }, body: markdownThread(f) }] },
                  },
                ],
              },
            },
          },
        },
      });
    }
    return jsonResponse([]);
  });

  const state = await platform.fetchState();

  assert.equal(state.threads.length, pageCount);
  assert.equal(state.threads[0].id, "T1");
  assert.equal(state.threads.at(-1).id, `T${pageCount}`);
  assert.equal(calls.filter((c) => c.url.endsWith("/graphql")).length, pageCount);
});

test("a repeated reviewThreads cursor rejects instead of looping", async () => {
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "same-cursor" }, nodes: [] },
            },
          },
        },
      });
    }
    return jsonResponse([]);
  });

  await assert.rejects(platform.fetchState(), /repeated cursor/);
});

test("a repeated issue-comment page URL rejects instead of looping", async () => {
  const page1 = "https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=1";
  const page2 = "https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=2";
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
      });
    }
    if (call.url === page1) return jsonResponse([], { headers: { link: `<${page2}>; rel="next"` } });
    return jsonResponse([], { headers: { link: `<${page1}>; rel="next"` } });
  });

  await assert.rejects(platform.fetchState(), /repeated URL/);
});

test("refuses a cross-origin pagination URL instead of sending the token there", async () => {
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
      });
    }
    return jsonResponse([], {
      headers: { link: '<https://evil.example/repos/acme/widgets/issues/7/comments?page=2>; rel="next"' },
    });
  });

  await assert.rejects(platform.fetchState(), /cross-origin pagination URL/);
});

test("caps Link-driven issue-comment pagination", async () => {
  const { platform, calls } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
      });
    }
    const url = new URL(call.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    url.searchParams.set("page", String(page + 1));
    return jsonResponse([], { headers: { link: `<${url.href}>; rel="next"` } });
  });

  await assert.rejects(platform.fetchState(), /exceeded 1000 pages/);
  assert.equal(calls.filter((call) => call.url.includes("/comments")).length, 1000);
});

test("a 200 GraphQL response without data rejects instead of reporting empty state", async () => {
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) return jsonResponse({ data: null });
    return jsonResponse([]);
  });

  await assert.rejects(platform.fetchState(), /GraphQL response contained no data/);
});

test("a GraphQL response missing repository.pullRequest rejects", async () => {
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) return jsonResponse({ data: { repository: null } });
    return jsonResponse([]);
  });

  await assert.rejects(platform.fetchState(), /repository\.pullRequest/);
});

test("a 200 issue-comments response that is not a list rejects", async () => {
  const { platform } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
      });
    }
    return jsonResponse({ message: "captive portal" });
  });

  await assert.rejects(platform.fetchState(), /not a JSON list/);
});

// ---------------------------------------------------------------------------
// postThreads
// ---------------------------------------------------------------------------

test("postThreads posts one COMMENT review with a RIGHT-side comment per finding", async () => {
  const a = finding();
  const b = finding({ file: "src/b.js", line: 21, severity: "Warning", title: "Leak" });
  const { platform, calls } = makePlatform(() => jsonResponse({ id: 555 }));

  const result = await platform.postThreads([
    { finding: a, anchor: { type: "add", oldLine: null } },
    { finding: b, anchor: { type: "context", oldLine: 18 } },
  ]);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/repos/acme/widgets/pulls/7/reviews"));
  assert.equal(call.body.event, "COMMENT");
  assert.equal(call.body.commit_id, HEAD_SHA);
  assert.equal(call.body.comments.length, 2);
  assert.deepEqual(Object.keys(call.body.comments[0]).sort(), ["body", "line", "path", "side"]);
  assert.deepEqual(
    call.body.comments.map(({ path, line, side }) => ({ path, line, side })),
    [
      { path: "src/a.js", line: 10, side: "RIGHT" },
      { path: "src/b.js", line: 21, side: "RIGHT" },
    ],
  );
  assert.ok(call.body.comments[0].body.startsWith("**Critical · security**"));

  assert.deepEqual(result.posted, [a, b]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.reviewId, "555");
});

test("postThreads retries per comment on a 422 and collects the failing one", async () => {
  const a = finding();
  const b = finding({ line: 20, title: "Second issue" });
  const { platform, calls } = makePlatform((call) => {
    if (call.body.comments.length === 2) {
      return jsonResponse({ message: "Unprocessable Entity", errors: ["line is invalid"] }, { status: 422 });
    }
    if (call.body.comments[0].line === 10) return jsonResponse({ id: 9001 });
    return jsonResponse({ message: "Unprocessable Entity" }, { status: 422 });
  });

  const result = await platform.postThreads([
    { finding: a, anchor: null },
    { finding: b, anchor: null },
  ]);

  assert.equal(calls.length, 3);
  assert.deepEqual(result.posted, [a]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].finding, b);
  assert.match(result.failed[0].error, /422/);
  assert.equal(result.reviewId, "9001");
});

test("postThreads with no items makes no API call", async () => {
  let called = 0;
  const { platform } = makePlatform(() => {
    called += 1;
    return jsonResponse({});
  });
  const result = await platform.postThreads([]);
  assert.deepEqual(result, { posted: [], failed: [], reviewId: null });
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------
// upsertSummary
// ---------------------------------------------------------------------------

test("upsertSummary PATCHes the newest bot summary and ignores human/older comments", async () => {
  const human = markdownSummary({ summary: "mine", findings: [], headSha: "deadbeef", prNumber: 7, unresolvedCount: 0 });
  const older = markdownSummary({ summary: "older", findings: [], headSha: "0123456", prNumber: 7, unresolvedCount: 0 });
  const bot = markdownSummary({ summary: "ours", findings: [], headSha: HEAD_SHA, prNumber: 7, unresolvedCount: 0 });
  const { platform, calls } = makePlatform((call) => {
    if (call.method === "GET") {
      return jsonResponse([
        { id: 101, ...commentAuthor("alice"), body: human },
        { id: 202, ...commentAuthor("github-actions[bot]"), body: older },
        { id: 303, ...commentAuthor("github-actions"), body: bot },
      ]);
    }
    return jsonResponse({ id: 303 });
  });

  await platform.upsertSummary(bot);

  assert.equal(calls.length, 2);
  const patch = calls[1];
  assert.equal(patch.method, "PATCH");
  assert.ok(patch.url.endsWith("/repos/acme/widgets/issues/comments/303"));
  assert.deepEqual(patch.body, { body: bot });
  assert.ok(!patch.url.includes("101"));
  assert.ok(!patch.url.includes("202"));
});

test("upsertSummary creates a comment when only a human marker comment exists", async () => {
  const human = markdownSummary({ summary: "mine", findings: [], headSha: "deadbeef", prNumber: 7, unresolvedCount: 0 });
  const { platform, calls } = makePlatform((call) => {
    if (call.method === "GET") {
      return jsonResponse([{ id: 101, ...commentAuthor("alice"), body: human }]);
    }
    return jsonResponse({ id: 303 });
  });

  await platform.upsertSummary(human);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "POST");
  assert.ok(calls[1].url.endsWith("/repos/acme/widgets/issues/7/comments"));
});

// ---------------------------------------------------------------------------
// GHES, retries, failures
// ---------------------------------------------------------------------------

test("GHES api/v3 maps to the /api/graphql endpoint", async () => {
  const { platform, calls } = makePlatform((call) => {
    if (call.url.endsWith("/graphql")) {
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      });
    }
    return jsonResponse([]);
  }, { env: { GITHUB_API_URL: "https://ghe.example.com/api/v3", GITHUB_SERVER_URL: "https://ghe.example.com" } });

  const state = await platform.fetchState();
  assert.deepEqual(state, { threads: [], lastReviewedSha: null });

  const urls = calls.map((call) => call.url);
  assert.ok(urls.includes("https://ghe.example.com/api/graphql"));
  assert.ok(urls.some((url) => url.startsWith("https://ghe.example.com/api/v3/repos/acme/widgets/issues/7/comments")));
});

test("retries a 502 and then succeeds", async () => {
  let attempts = 0;
  const { platform, calls, delays } = makePlatform(() => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ message: "Bad Gateway" }, { status: 502 });
    return jsonResponse({ id: 1 });
  });

  await platform.setStatus("success", "All clear");

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(calls[1].body.state, "success");
});

test("fails fast on a 403 without retrying, and the message carries the status", async () => {
  const { platform, calls, delays } = makePlatform(() =>
    jsonResponse({ message: "Resource not accessible by integration" }, { status: 403 }),
  );

  await assert.rejects(platform.setStatus("failure", "Nope"), (error) => {
    assert.match(error.message, /403/);
    assert.match(error.message, /Resource not accessible by integration/);
    assert.match(error.message, /POST/);
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("honours Retry-After seconds on a 429", async () => {
  let attempts = 0;
  const { platform, calls, delays } = makePlatform(() => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ message: "rate limited" }, { status: 429, headers: { "retry-after": "2" } });
    return jsonResponse({ id: 2 });
  });

  await platform.setStatus("success", "ok");

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [2000]);
});

test("honours Retry-After beyond the generated backoff cap", async () => {
  let attempts = 0;
  const { platform, calls, delays } = makePlatform(
    () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ message: "rate limited" }, { status: 429, headers: { "retry-after": "120" } });
      return jsonResponse({ id: 2 });
    },
    { retryBaseMs: 100_000 },
  );

  await platform.setStatus("success", "ok");

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [120_000]);
});

test("caps only generated backoff, not Retry-After", async () => {
  let attempts = 0;
  const { platform, calls, delays } = makePlatform(
    () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ message: "Bad Gateway" }, { status: 502 });
      return jsonResponse({ id: 4 });
    },
    { retryBaseMs: 100_000 },
  );

  await platform.setStatus("success", "ok");

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [60_000]);
});

test("refuses an absurd Retry-After instead of stalling the job", async () => {
  const { platform, calls, delays } = makePlatform(() =>
    jsonResponse({ message: "slow down" }, { status: 429, headers: { "retry-after": "1000000" } }),
  );

  await assert.rejects(platform.setStatus("failure", "Nope"), /Retry-After/);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("fails fast on a redirect instead of treating it as a successful write", async () => {
  const { platform, calls } = makePlatform(() =>
    jsonResponse({}, { status: 302, headers: { location: "https://evil.example/" } }),
  );

  await assert.rejects(platform.setStatus("success", "ok"), /redirect/);
  assert.equal(calls.length, 1);
});

test("gives up after three 5xx attempts and reports the last status", async () => {
  const { platform, calls, delays } = makePlatform(() => jsonResponse({ message: "boom" }, { status: 500 }));

  await assert.rejects(platform.setStatus("failure", "Nope"), (error) => {
    assert.equal(error.status, 500);
    assert.match(error.message, /status 500/);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("GraphQL errors on resolveThread throw", async () => {
  const { platform } = makePlatform(() =>
    jsonResponse({ data: null, errors: [{ message: "Resource not accessible by integration" }] }),
  );
  await assert.rejects(platform.resolveThread({ id: "T1" }), /Resource not accessible/);
  await assert.rejects(platform.resolveThread({}), /thread id/);
});

// ---------------------------------------------------------------------------
// resolveThread / setStatus / fileUrl / headers
// ---------------------------------------------------------------------------

test("resolveThread sends the GraphQL mutation with the thread id", async () => {
  const { platform, calls } = makePlatform((call) => {
    assert.ok(call.url.endsWith("/graphql"));
    return jsonResponse({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } });
  });

  await platform.resolveThread({ id: "T1" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body.variables, { id: "T1" });
  assert.match(calls[0].body.query, /resolveReviewThread/);
});

test("setStatus truncates the description to 140 characters", async () => {
  const { platform, calls } = makePlatform(() => jsonResponse({ id: 1 }));

  await platform.setStatus("failure", "x".repeat(200));

  const [call] = calls;
  assert.ok(call.url.endsWith(`/repos/acme/widgets/statuses/${HEAD_SHA}`));
  assert.equal(call.body.state, "failure");
  assert.equal(call.body.context, "code-review-agent");
  assert.equal(call.body.description.length, 140);
});

test("fileUrl encodes the path and anchors the line", () => {
  const { platform } = makePlatform(() => jsonResponse({}), {
    env: { GITHUB_SERVER_URL: "https://ghe.example.com/" },
  });
  assert.equal(
    platform.fileUrl("src/a b.js", 12),
    `https://ghe.example.com/acme/widgets/blob/${HEAD_SHA}/src/a%20b.js#L12`,
  );
  assert.equal(
    platform.fileUrl("./src/deep/x.js"),
    `https://ghe.example.com/acme/widgets/blob/${HEAD_SHA}/src/deep/x.js`,
  );
  assert.equal(
    platform.fileUrl("src/a) (b#c?.js", 3),
    `https://ghe.example.com/acme/widgets/blob/${HEAD_SHA}/src/a%29%20%28b%23c%3F.js#L3`,
  );
});

test("requests carry auth headers and never put the token in the URL", async () => {
  const { platform, calls } = makePlatform(() =>
    jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }),
  );

  await platform.fetchState().catch(() => {});

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers.Accept, "application/vnd.github+json");
    assert.equal(call.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(call.headers["User-Agent"], "code-review-agent");
    assert.ok(!call.url.includes(TOKEN));
  }
});
