/**
 * mnemos core logic — everything except MCP wiring, so it is unit-testable
 * without spawning a server. All functions that touch the filesystem resolve
 * paths through the CHROME_BOOKMARKS_PATH / CHROME_PROFILE environment
 * variables, which is also how tests inject fixtures.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domainToUnicode } from "node:url";

export interface BookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  children?: BookmarkNode[];
}

export interface Entry {
  folder: string;
  node: BookmarkNode;
}

/** Path segments are joined with this — "/" can appear in folder names. */
export const SEP = " › ";

export function chromeBase(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    // `||`, not `??`: an env var set to the empty string means "unset" (the
    // XDG spec says so explicitly), and `??` would let it through and build a
    // relative path that silently resolves against the process's cwd.
    case "win32":
      return path.join(
        env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "Google",
        "Chrome",
        "User Data",
      );
    default: // linux and other unixes
      return path.join(
        env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "google-chrome",
      );
  }
}

export function bookmarksPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.CHROME_BOOKMARKS_PATH;
  if (override) return override;
  const profile = env.CHROME_PROFILE || "Default"; // empty string → Default
  return path.join(chromeBase(platform, env), profile, "Bookmarks");
}

export function loadRoots(): Record<string, BookmarkNode> {
  const file = bookmarksPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    const base = chromeBase();
    let available: string[] = [];
    try {
      available = fs
        .readdirSync(base)
        .filter((d) => fs.existsSync(path.join(base, d, "Bookmarks")))
        .sort();
    } catch {
      // base dir itself missing — fall through with empty list
    }
    throw new Error(
      `No bookmarks file at ${file}. ` +
        `Chrome profiles that have bookmarks: ${available.join(", ") || "none"}. ` +
        "Set CHROME_PROFILE (profile directory name) or CHROME_BOOKMARKS_PATH.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Bookmarks file at ${file} is not valid JSON (${e}). ` +
        "Chrome may be mid-write; retry in a moment.",
    );
  }
  // Valid JSON is not enough: pointing CHROME_BOOKMARKS_PATH at the wrong file
  // must not look like "this user has no bookmarks". A real Chrome file always
  // has roots.{bookmark_bar,other,synced}, each a folder node with a children
  // array — even on a brand-new profile — so requiring one such node
  // distinguishes a foreign file from a genuinely empty one.
  const roots = isRecord(parsed) ? parsed.roots : undefined;
  const looksLikeChrome =
    isRecord(roots) && Object.values(roots).some((r) => isRecord(r) && Array.isArray(r.children));
  if (!looksLikeChrome) {
    throw new Error(
      `File at ${file} is not a Chrome Bookmarks file: no "roots" object containing ` +
        "bookmark folders. Point CHROME_BOOKMARKS_PATH at Chrome's 'Bookmarks' file " +
        "(no extension), or set CHROME_PROFILE instead.",
    );
  }
  return roots as Record<string, BookmarkNode>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Milliseconds a `date_added` may sit ahead of now before we call it corrupt. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

// Chrome timestamps are microseconds since 1601-01-01 UTC. Imported or
// corrupted bookmarks can carry out-of-range values — never let one bad
// timestamp fail a whole tool call. Dates are rendered in the machine's
// local timezone so "added yesterday evening" doesn't shift a day.
// `now` is a parameter purely so tests can pin it.
export function chromeTimeToIso(value: string | undefined, now: number = Date.now()): string | null {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  const ms = micros / 1000 - 11_644_473_600_000;
  // A bookmark cannot have been added in the future. Bad imports and skewed
  // system clocks produce dates centuries ahead that are still perfectly valid
  // JS Dates, so checking Date validity alone does not catch them — the bound
  // has to be against the clock, with a day of slack for timezone/skew noise.
  if (ms > now + MAX_CLOCK_SKEW_MS) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Chrome writes `type` on every node, but CHROME_BOOKMARKS_PATH accepts any
// file, and hand-made or third-party exports sometimes omit it. Falling back
// to the node's shape means a missing `type` can never silently drop a whole
// subtree of the user's bookmarks.
function isUrlNode(node: BookmarkNode): boolean {
  return node.type === "url" || (node.type === undefined && typeof node.url === "string");
}

function isFolderNode(node: BookmarkNode): boolean {
  return node.type === "folder" || (node.type === undefined && Array.isArray(node.children));
}

/**
 * A traversal step. Folders are reported as well as bookmarks so that
 * list_folders can show folders that hold only subfolders, or nothing at all.
 */
export type Visit =
  | { kind: "url"; folder: string; node: BookmarkNode }
  | { kind: "folder"; folder: string };

/**
 * Pre-order depth-first traversal over one root. Uses an explicit stack rather
 * than recursive `yield*` delegation: recursion overflowed the call stack on
 * deeply nested trees (~2k levels) and cost O(depth) per yielded item.
 */
function* walk(root: BookmarkNode, rootPath: string): Generator<Visit> {
  const stack: { node: BookmarkNode; folder: string }[] = [{ node: root, folder: rootPath }];
  while (stack.length > 0) {
    const { node, folder } = stack.pop()!;
    if (isUrlNode(node)) {
      yield { kind: "url", folder, node };
      continue;
    }
    yield { kind: "folder", folder };
    const children = node.children ?? [];
    // Pushed in reverse so siblings pop in document order.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (isUrlNode(child)) {
        stack.push({ node: child, folder });
      } else if (isFolderNode(child)) {
        stack.push({ node: child, folder: `${folder}${SEP}${child.name ?? ""}` });
      }
      // Anything that is neither is not a bookmark node — skip it silently.
    }
  }
}

const ROOT_LABELS: Record<string, string> = {
  bookmark_bar: "Bookmarks Bar",
  other: "Other Bookmarks",
  synced: "Mobile Bookmarks",
};

export function* walkAll(): Generator<Visit> {
  for (const [key, root] of Object.entries(loadRoots())) {
    // Chrome stores non-tree values alongside the roots (e.g. the
    // "sync_transaction_version" string). Requiring a folder-shaped node keeps
    // those out — they would otherwise show up as folders in list_folders,
    // which now reports folders that hold nothing.
    if (root && typeof root === "object" && isFolderNode(root)) {
      yield* walk(root, ROOT_LABELS[key] ?? key);
    }
  }
}

export function* allBookmarks(): Generator<Entry> {
  for (const visit of walkAll()) {
    if (visit.kind === "url") yield { folder: visit.folder, node: visit.node };
  }
}

/** Escape a user-supplied string for literal use inside a RegExp. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `needle` matches a folder name in the path at a word boundary.
 * Matching per path segment (not just the joined path) prevents false
 * positives like "ai" matching "Painting". JS `\b` is ASCII-only, so
 * Unicode-aware lookarounds are required for non-Latin folder names (e.g.
 * Greek). The joined path is tested too, so a folder literally named "A › B"
 * — which renders indistinguishably from B nested inside A — stays reachable.
 */
export function folderMatches(fpath: string, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return true;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`,
    "u",
  );
  return [...fpath.split(SEP), fpath].some((candidate) => pattern.test(candidate.toLowerCase()));
}

/**
 * A query word matches at the start of a word, so "kubernet" still finds
 * "Kubernetes" while "ai" no longer matches "Gmail" or "Painting". Plain
 * substring matching turned short topical queries — by far the most likely
 * ones here — into mostly noise, and the caller could not tell.
 */
export function queryMatches(haystack: string, word: string): boolean {
  return wordStart(word).test(haystack);
}

function wordStart(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}`, "u");
}

// Titles and URLs are unbounded in the source file, and a single bookmark
// carrying a giant title or a data: URI should not be able to blow up a tool
// result. 2048 is past any real navigable URL, so live links are never
// mangled — only junk gets clipped.
const MAX_TITLE = 500;
const MAX_URL = 2048;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function fmt(entry: Entry) {
  return {
    title: clip(entry.node.name ?? "", MAX_TITLE),
    url: clip(entry.node.url ?? "", MAX_URL),
    folder: entry.folder,
    added: chromeTimeToIso(entry.node.date_added),
  };
}

/**
 * Clamp a caller-supplied limit into [0, max]. A non-finite limit falls back
 * to the default instead of propagating NaN into `slice`, which would return
 * an empty list while `total_matches` claimed there were hits.
 */
export function cap(limit: number | undefined, fallback: number, max = 200): number {
  const requested = Number.isFinite(limit) ? (limit as number) : fallback;
  return Math.max(0, Math.min(requested, max));
}

// ---------------------------------------------------------------------------
// Tool implementations — plain objects in, plain JSON-able objects out.
// ---------------------------------------------------------------------------

export function searchBookmarks(query: string, folder?: string, limit?: number): unknown {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return {
      error:
        "Empty query. Provide one or more search words, or use " +
        "list_folders / recent_bookmarks to browse instead.",
    };
  }
  // The filter is optional, so a blank one means "no filter" rather than an
  // error — unlike list_folder_contents, where the folder is the whole request.
  const filter = folder?.trim() ? folder : undefined;
  const patterns = words.map(wordStart);
  const matches = [];
  for (const entry of allBookmarks()) {
    if (filter && !folderMatches(entry.folder, filter)) continue;
    const haystack =
      `${entry.node.name ?? ""} ${entry.node.url ?? ""} ${entry.folder}`.toLowerCase();
    if (patterns.every((p) => p.test(haystack))) {
      matches.push(fmt(entry));
    }
  }
  if (matches.length === 0) {
    return {
      total_matches: 0,
      matches: [],
      // Say when a folder filter was in play: otherwise a mistyped folder name
      // reads as "the user has saved nothing on this topic".
      note: filter
        ? `No bookmarks match "${query}" in folders matching "${filter}". The folder ` +
          "name may be wrong — call list_folders to check, or retry without `folder`."
        : `No bookmarks match "${query}".`,
    };
  }
  return { total_matches: matches.length, matches: matches.slice(0, cap(limit, 100)) };
}

export function listFolders(): unknown {
  // Every folder in the tree gets a row, including ones holding only
  // subfolders or nothing at all: those names are part of the user's taxonomy
  // even when no bookmark sits directly inside them, and counting only folders
  // with direct children made them invisible.
  const direct = new Map<string, number>();
  for (const visit of walkAll()) {
    if (visit.kind === "folder") {
      if (!direct.has(visit.folder)) direct.set(visit.folder, 0);
    } else {
      direct.set(visit.folder, (direct.get(visit.folder) ?? 0) + 1);
    }
  }
  // list_folder_contents includes subfolders, so the subtree total is what
  // predicts its result size — report both.
  const subtree = new Map<string, number>();
  for (const [folder, n] of direct) {
    const segments = folder.split(SEP);
    for (let i = segments.length; i > 0; i--) {
      const ancestor = segments.slice(0, i).join(SEP);
      subtree.set(ancestor, (subtree.get(ancestor) ?? 0) + n);
    }
  }
  const folders = [...direct.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, n]) => ({
      folder,
      bookmarks: n,
      subtree_bookmarks: subtree.get(folder) ?? n,
    }));
  const total = [...direct.values()].reduce((sum, n) => sum + n, 0);
  return { folders, total_bookmarks: total };
}

export function listFolderContents(folder: string, limit?: number): unknown {
  if (!folder.trim()) {
    return { error: "Empty folder name. Call list_folders to see available folders." };
  }
  const matches = [];
  for (const entry of allBookmarks()) {
    if (folderMatches(entry.folder, folder)) {
      matches.push(fmt(entry));
    }
  }
  if (matches.length === 0) {
    return { total_matches: 0, bookmarks: [], note: `No folder matches "${folder}".` };
  }
  return { total_matches: matches.length, bookmarks: matches.slice(0, cap(limit, 100)) };
}

export function recentBookmarks(limit?: number): unknown {
  const items: { added: number; entry: Entry }[] = [];
  for (const entry of allBookmarks()) {
    // Corrupt far-future timestamps must not float to the top of the list:
    // only timestamps that render as a real date participate in ordering.
    const valid = chromeTimeToIso(entry.node.date_added) !== null;
    items.push({ added: valid ? Number(entry.node.date_added) : 0, entry });
  }
  items.sort((a, b) => b.added - a.added);
  return {
    total_matches: items.length,
    bookmarks: items.slice(0, cap(limit, 100)).map((i) => fmt(i.entry)),
  };
}

export function topDomains(limit?: number): unknown {
  const counts = new Map<string, number>();
  for (const entry of allBookmarks()) {
    let host = "";
    try {
      const url = new URL(entry.node.url ?? "");
      // Only web pages count as "sources" — skip chrome://, file://, etc.
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      // Render internationalized domains readably, not as xn-- punycode.
      host = domainToUnicode(url.hostname.replace(/^www\./, ""));
    } catch {
      continue; // bookmarklets and malformed URLs
    }
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, cap(limit, 25, 100))
    .map(([domain, n]) => ({ domain, bookmarks: n }));
  // Without the total, a truncated list reads as the user's complete set of
  // trusted sources — which is exactly how the tool description says to use it.
  return { total_matches: counts.size, domains: top };
}
