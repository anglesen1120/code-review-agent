// Deterministic, platform-agnostic review-thread lifecycle. Zero dependencies.
//
// Never calls an LLM and never executes text from threads/comments — it only
// matches normalized string keys (the prompt-injection boundary). Platform
// adapters (src/platforms/*) do the I/O; this module decides what to post,
// what to keep open, and what to resolve.

export const THREAD_MARKER = "<!-- code-review-agent -->";
export const SUMMARY_MARKER = "<!-- code-review-agent:summary -->";
const REVIEWED_SHA_RE = /<!-- code-review-agent:reviewed-sha=([0-9a-f]{7,64}) -->/;

export const rank = { Critical: 3, Warning: 2, Info: 1 };

/** Findings this far apart (in lines) on one file are never treated as the same issue. */
export const DEFAULT_LINE_WINDOW = 30;

export function normalizeTitle(t) {
  return String(t).trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
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

/**
 * Neutralize model-authored text before it reaches a PR: break @mentions (no
 * pings from prompt-injected output) and HTML comments (no spoofed markers).
 */
export function sanitize(text) {
  return String(text ?? "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@\u200b");
}

const heading = (f) => `**${f.severity} · ${f.category}** — ${sanitize(f.title).replace(/\s*\n\s*/g, " ")}`;

export function markdownThread(f) {
  return [
    heading(f),
    "",
    sanitize(f.description),
    "",
    "**Suggestion:**",
    sanitize(f.suggestion),
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
export function markdownSummary({ summary, findings, headSha, prNumber, unresolvedCount, fileUrl, notes = [], prLabel = "PR" }) {
  const loc = (f) => (fileUrl ? `[${f.file}:${f.line}](${fileUrl(f.file, f.line)})` : `\`${f.file}:${f.line}\``);
  const groups = { Critical: [], Warning: [], Info: [] };
  for (const f of findings) groups[f.severity]?.push(f);
  const lines = [
    SUMMARY_MARKER,
    `<!-- code-review-agent:reviewed-sha=${headSha} -->`,
    "## Code Review Summary",
    "",
    sanitize(summary),
    "",
    `Reviewed \`${headSha}\`${prNumber ? ` (${prLabel} #${prNumber})` : ""} · **Critical: ${groups.Critical.length} · Warning: ${groups.Warning.length} · Info: ${groups.Info.length}**`,
  ];
  for (const sev of ["Critical", "Warning", "Info"]) {
    if (groups[sev].length === 0) continue;
    lines.push("", `### ${sev}`);
    for (const f of groups[sev]) {
      const gist = sanitize(f.description.split("\n")[0]);
      lines.push(`- [${f.category}] **${sanitize(f.title)}** — ${loc(f)} — ${gist}`);
    }
  }
  if (notes.length > 0) {
    lines.push("", "<details><summary>Notes</summary>", "");
    for (const n of notes) lines.push(`- ${sanitize(n)}`);
    lines.push("", "</details>");
  }
  if (unresolvedCount > 0) {
    lines.push("", `> **Merge gate:** ${unresolvedCount} unresolved review thread(s) remain. Fix them (or reply and resolve) to unblock merge.`);
  }
  lines.push("");
  return lines.join("\n");
}
