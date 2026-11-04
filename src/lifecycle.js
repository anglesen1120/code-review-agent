// Deterministic, platform-agnostic review-thread lifecycle. Zero dependencies.
//
// Never calls an LLM and never executes text from threads/comments — it only
// matches normalized string keys (the prompt-injection boundary). Platform
// adapters (src/platforms/*) do the I/O; this module decides what to post,
// what to keep open, and what to resolve.

import { CAPS, truncateField } from "./validate.js";

export const THREAD_MARKER = "<!-- code-review-agent -->";
export const SUMMARY_MARKER = "<!-- code-review-agent:summary -->";
const REVIEWED_SHA_RE = /<!-- code-review-agent:reviewed-sha=([0-9a-f]{7,64}) -->/;

export const rank = { Critical: 3, Warning: 2, Info: 1 };

/** Findings this far apart (in lines) on one file are never treated as the same issue. */
export const DEFAULT_LINE_WINDOW = 30;

// Zero-width characters are stripped: they are inserted by `sanitize` to
// neutralize quick actions/mentions, and they must never change thread keys.
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\ufeff]/g;

export function normalizeTitle(t) {
  return String(t).replace(ZERO_WIDTH_RE, "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
}

export function threadKey(f) {
  return `${f.file}:${f.line}:${normalizeTitle(f.title)}`;
}

const significant = (t) => normalizeTitle(t).split(" ").filter((w) => w.length > 2);

// Fuzzy title similarity for LLM re-wordings ("Parameterize SQL query to
// prevent SQL injection in getUser" vs "SQL injection via string concatenation
// in getUser"). Strict enough that distinct issues rarely match.
export function similarTitle(a, b) {
  const wa = significant(a ?? "");
  const wb = significant(b ?? "");
  if (wa.length === 0 || wb.length === 0) return false;
  const shared = wa.filter((w) => wb.includes(w)).length;
  if (shared >= 3 && shared >= Math.min(wa.length, wb.length) / 2) return true;
  const na = normalizeTitle(a ?? "");
  const nb = normalizeTitle(b ?? "");
  return na.length > 3 && (nb.startsWith(na) || na.startsWith(nb));
}

// Fuzzy guard: an open, current thread at the same path:line with a
// near-identical title is the same issue (LLM re-wording).
export function sameLocationGuard(thread, finding) {
  if (!thread || thread.path !== finding.file) return false;
  if (thread.line !== finding.line) return false;
  return similarTitle(thread.title, finding.title);
}

/**
 * Find the existing thread (open or resolved) that already reports `f`.
 * Order: exact key → same path:line + similar title → same path + similar
 * title within `lineWindow` lines (or the thread is outdated, so its line is
 * unreliable). The window keeps a genuinely new issue of the same kind
 * elsewhere in the file from being swallowed.
 */
export function matchThread(f, threads, lineWindow = DEFAULT_LINE_WINDOW) {
  const key = threadKey(f);
  return (
    threads.find((t) => t.key === key) ??
    threads.find((t) => !t.isResolved && !t.isOutdated && sameLocationGuard(t, f)) ??
    threads.find(
      (t) =>
        t.path === f.file &&
        similarTitle(t.title ?? "", f.title) &&
        (t.isOutdated || Math.abs((t.line ?? 0) - f.line) <= lineWindow),
    ) ??
    null
  );
}

/**
 * Core lifecycle logic. Pure and deterministic.
 *
 * @param {object[]} findings         validated findings of this run
 * @param {object[]} existingThreads  this bot's threads: {id,key,path,line,title,severity?,isResolved,isOutdated}
 * @param {string[]} changedFiles     files whose code changed since the last
 *                                    reviewed commit (all PR files when unknown)
 * @returns {{toPost: object[], toResolve: object[], kept: object[], unresolvedCount: number, counts: object}}
 *   kept = open threads whose issue was re-reported this run (stay open).
 */
export function computeDelta(findings, existingThreads, changedFiles, { lineWindow = DEFAULT_LINE_WINDOW } = {}) {
  const desired = new Map(); // key -> finding, highest severity wins
  const counts = { Critical: 0, Warning: 0, Info: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    if (f.severity !== "Critical" && f.severity !== "Warning") continue;
    const k = threadKey(f);
    const cur = desired.get(k);
    if (!cur || rank[f.severity] > rank[cur.severity]) desired.set(k, f);
  }

  const matched = new Set(); // thread ids whose issue persists this run
  const toPost = [];
  for (const f of desired.values()) {
    const t = matchThread(f, existingThreads, lineWindow);
    if (t) {
      // Already reported: an open thread stays open; a dev-resolved thread
      // stays resolved and is never re-nagged.
      matched.add(t.id);
      continue;
    }
    toPost.push(f);
  }

  const changed = new Set(changedFiles);
  const toResolve = [];
  const kept = [];
  for (const t of existingThreads) {
    if (t.isResolved) continue; // dev-resolved threads are NEVER reopened
    if (matched.has(t.id)) {
      kept.push(t); // issue persists (possibly re-worded / shifted) -> keep open
      continue;
    }
    // Conservative: only auto-resolve when the code under the thread changed.
    if (t.isOutdated || changed.has(t.path)) toResolve.push(t);
  }

  const resolveIds = new Set(toResolve.map((t) => t.id));
  const remainingOpen = existingThreads.filter((t) => !t.isResolved && !resolveIds.has(t.id)).length;
  const unresolvedCount = remainingOpen + toPost.length;

  return { toPost, toResolve, kept, unresolvedCount, counts };
}

/**
 * Merge gate. `failOn` is "none" | "critical" | "warning".
 * @param {(string|undefined)[]} severities severities of the threads/findings still open
 */
export function gateFails(severities, failOn) {
  if (failOn === "critical") return severities.some((s) => s === "Critical");
  if (failOn === "warning") return severities.some((s) => s === "Critical" || s === "Warning");
  return false;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/** Characters that must never reach a comment body (C0/C1, line/paragraph separators). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * CommonMark fence opener, or null. An info string after a backtick fence may
 * not contain a backtick (§4.5), so "``` bad`info" is an ordinary paragraph and
 * must NOT be treated as a fence — otherwise the paragraph after it would be
 * skipped by `sanitize` and its `/approve` would stay executable. Tilde fences
 * repeating the fence character are rejected too, which only over-neutralizes
 * inside code (cosmetic) and never skips a live paragraph.
 */
function fenceOpener(line) {
  const m = line.match(FENCE_OPEN_RE);
  if (!m || m[2].includes(m[1][0])) return null;
  return { char: m[1][0], length: m[1].length };
}

const fenceCloses = (line, fence) => {
  const m = line.match(FENCE_CLOSE_RE);
  return Boolean(m && m[1][0] === fence.char && m[1].length >= fence.length);
};

/** The closing fence line needed to terminate `text`, or "" when it is balanced. */
function closingFenceFor(text) {
  let fence = null;
  for (const line of String(text).split("\n")) {
    if (fence) {
      if (fenceCloses(line, fence)) fence = null;
    } else {
      fence = fenceOpener(line);
    }
  }
  return fence ? fence.char.repeat(fence.length) : "";
}

/**
 * Neutralize model-authored text before it reaches a PR: break @mentions (no
 * pings from prompt-injected output), HTML comments (no spoofed markers) and
 * GitLab quick actions.
 *
 * GitLab runs a quick action when a line starts with `/` (leading whitespace is
 * tolerated and commands are read line by line — https://docs.gitlab.com/user/project/quick_actions/),
 * so `\n/approve` in a review body would approve the merge request. Every line
 * that starts with `/` gets a zero-width space before the slash: invisible in
 * the rendered comment, inert to GitLab, and stripped again by `normalizeTitle`.
 *
 * GitLab extracts quick actions from markdown paragraphs only, so lines inside
 * a fenced code block are safe: they are left byte-identical (`// comment`,
 * `@Override` must stay copy-pasteable). Because an unterminated fence would
 * swallow the thread/summary marker that follows, an open fence at the end of
 * the text gets a closing fence line appended.
 */
export function sanitize(text) {
  const lines = String(text ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/<!--/g, "&lt;!--")
    .split("\n");
  const out = [];
  let fence = null; // { char, length } of the open fence
  for (const line of lines) {
    if (fence) {
      out.push(line);
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpener(line);
    if (open) {
      fence = open;
      out.push(line);
      continue;
    }
    out.push(neutralizeLine(line));
  }
  if (fence) out.push(fence.char.repeat(fence.length));
  return out.join("\n");
}

/** Break @mentions and a line-leading `/` (GitLab quick action) on one plain line. */
function neutralizeLine(line) {
  return line
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@\u200b")
    .replace(/^([ \t]*)\//, "$1\u200b/");
}

/** Single-line model text (titles, gists): newlines cannot survive into a heading. */
export function inlineText(text) {
  return sanitize(String(text ?? "").replace(/[\r\n]+/g, " ")).replace(/[\r\n]+/g, " ");
}

/**
 * Metadata text (notes: skipped files, dropped findings, adapter errors) is
 * rendered inside a list item, where CommonMark's list/fence interaction is
 * easy to get wrong. Neutralize every line without a code exception — notes
 * never need copy-pasteable code — and still close an unterminated fence.
 */
function sanitizeMetadata(text) {
  const body = String(text ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/<!--/g, "&lt;!--")
    .split("\n")
    .map(neutralizeLine)
    .join("\n");
  const closing = closingFenceFor(body);
  return closing ? `${body}\n${closing}` : body;
}

// Markdown inline code that a filename cannot break out of (backticks, newlines).
export function codeSpan(text) {
  const s = String(text).replace(/[\r\n\t]+/g, " ").replace(/<!--/g, "&lt;!--");
  const longest = (s.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

// Square brackets are percent-encoded inside a link label: a model-controlled
// filename such as `](https://evil)` must never close the label or open a link.
const noBrackets = (text) => String(text).replace(/\[/g, "%5B").replace(/\]/g, "%5D");

const heading = (f) => `**${f.severity} · ${f.category}** — ${inlineText(f.title)}`;

export function markdownThread(f) {
  return [
    heading(f),
    "",
    // Truncate first: `sanitize` appends a closing fence for an unterminated
    // block, and cutting the text afterwards would strip it again.
    sanitize(truncateField(f.description, CAPS.description)),
    "",
    "**Suggestion:**",
    sanitize(truncateField(f.suggestion, CAPS.suggestion)),
    "",
    THREAD_MARKER,
  ].join("\n");
}

/** Parse a thread root comment written by markdownThread. */
export function parseThreadBody(body) {
  const first = (body ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const m = first.match(/^\*\*(Critical|Warning|Info)\b[^*]*\*\*\s*(?:—|-)?\s*(.*)$/);
  if (m) return { severity: m[1], title: m[2] };
  return { severity: undefined, title: first.replace(/^\*\*[^*]*\*\*\s*(—|-)?\s*/, "") };
}

export function isOwnThreadBody(body) {
  return typeof body === "string" && body.includes(THREAD_MARKER);
}

export function parseReviewedSha(body) {
  if (typeof body !== "string" || !body.startsWith(SUMMARY_MARKER)) return null;
  return body.match(REVIEWED_SHA_RE)?.[1] ?? null;
}

/**
 * @param {object} p
 * @param {string} p.summary
 * @param {object[]} p.findings
 * @param {string} p.headSha
 * @param {string|number} [p.prNumber]
 * @param {number} p.unresolvedCount
 * @param {(file: string, line: number) => string} [p.fileUrl] link builder; plain text when absent
 * @param {string[]} [p.notes] extra lines (skipped files, dropped findings, analysis errors)
 * @param {string} [p.prLabel] "PR" | "MR"
 */
export const MAX_SUMMARY_BODY = 59000;
const GIST_MAX = 200;
const NOTE_MAX = 500;

export function markdownSummary({ summary, findings = [], headSha, prNumber, unresolvedCount, fileUrl, notes = [], prLabel = "PR" }) {
  const loc = (f) => {
    const text = truncateField(noBrackets(`${f.file}:${f.line}`), 300);
    if (!fileUrl) return codeSpan(text);
    return `[${codeSpan(text)}](${truncateField(fileUrl(f.file, f.line), 500)})`;
  };
  const gistOf = (f) => {
    const first = String(f.description ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
    return truncateField(inlineText(first), GIST_MAX);
  };
  const findingLine = (f) =>
    `- [${inlineText(f.category)}] **${truncateField(inlineText(f.title), CAPS.title)}** — ${loc(f)} — ${gistOf(f)}`;
  const groups = { Critical: [], Warning: [], Info: [] };
  for (const f of findings ?? []) groups[f.severity]?.push(f);

  const head = [
    SUMMARY_MARKER,
    `<!-- code-review-agent:reviewed-sha=${headSha} -->`,
    "## Code Review Summary",
    "",
    sanitize(truncateField(summary, CAPS.summary)),
    "",
    `Reviewed \`${headSha}\`${prNumber ? ` (${prLabel} #${prNumber})` : ""} · **Critical: ${groups.Critical.length} · Warning: ${groups.Warning.length} · Info: ${groups.Info.length}**`,
  ];
  const tail = [];
  if (notes.length > 0) {
    tail.push("", "<details><summary>Notes</summary>", "");
    for (const n of notes) tail.push(`- ${sanitizeMetadata(truncateField(n, NOTE_MAX))}`);
    tail.push("", "</details>");
  }
  if (unresolvedCount > 0) {
    tail.push("", `> **Merge gate:** ${unresolvedCount} unresolved review thread(s) remain. Fix them (or reply and resolve) to unblock merge.`);
  }
  tail.push("");

  const body = [...head, ...tail].join("\n");
  if (body.length <= MAX_SUMMARY_BODY) {
    const full = [...head];
    for (const sev of ["Critical", "Warning", "Info"]) {
      if (groups[sev].length === 0) continue;
      full.push("", `### ${sev}`);
      for (const f of groups[sev]) full.push(findingLine(f));
    }
    const withFindings = [...full, ...tail].join("\n");
    if (withFindings.length <= MAX_SUMMARY_BODY) return withFindings;
  }

  // Over budget: keep the header and as many findings as fit, then say what was dropped.
  const out = [...head];
  let used = head.join("\n").length;
  const reserved = tail.join("\n").length + 2;
  let omitted = 0;
  for (const sev of ["Critical", "Warning", "Info"]) {
    let header = false;
    for (const f of groups[sev]) {
      const line = findingLine(f);
      if (used + line.length + reserved + 2 > MAX_SUMMARY_BODY) {
        omitted += 1;
        continue;
      }
      if (!header) {
        out.push("", `### ${sev}`);
        used += sev.length + 6;
        header = true;
      }
      out.push(line);
      used += line.length + 1;
    }
  }
  if (omitted > 0) {
    out.push("", `_${omitted} finding(s) omitted to keep this comment under ${MAX_SUMMARY_BODY} characters._`);
  }
  out.push(...tail);
  const text = out.join("\n");
  if (text.length <= MAX_SUMMARY_BODY) return text;
  // Last-resort clamp: close any fence the cut re-opened, so the size note is
  // never swallowed into a code block.
  const cut = text.slice(0, MAX_SUMMARY_BODY - 64);
  const closing = closingFenceFor(cut);
  return `${cut}${closing ? `\n${closing}` : ""}\n\n_… truncated to fit the comment size limit._\n`;
}
