/**
 * mnemos core logic — everything except MCP wiring, so it is unit-testable
 * without spawning a server. All functions that touch the filesystem resolve
 * paths through the --browser / --profile startup flags and the
 * MNEMOS_BOOKMARKS_PATH / MNEMOS_PROFILE / MNEMOS_BOOKMARKS_BROWSER environment
 * variables (CHROME_BOOKMARKS_PATH and CHROME_PROFILE are older aliases), which
 * is also how tests inject fixtures. Where each browser keeps its bookmarks, and the readers for
 * Firefox's and Safari's formats, live in browsers.ts.
 */

import fs from "node:fs";
import { domainToUnicode } from "node:url";
import {
  BROWSER_ENV,
  BROWSER_NAMES,
  PATH_ENV,
  PROFILE_ENV,
  bookmarksPathOverride,
  browsersWithBookmarks,
  chromiumBase,
  chromiumBookmarksPath,
  chromiumProfiles,
  firefoxBase,
  firefoxPlacesPath,
  firefoxProfilesWithBookmarks,
  isChromium,
  isSqlite,
  readFirefoxRoots,
  readSafariRoots,
  safariBookmarksPath,
  selectedBrowser,
  selectedProfile,
  type Browser,
  type StartupOptions,
} from "./browsers.js";
import { isBinaryPlist } from "./plist.js";

export interface BookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  /** Chromium's stable id for the node; the Firefox and Safari readers leave it out. */
  guid?: string;
  children?: BookmarkNode[];
  /** Chromium's per-node metadata; Vivaldi keeps a bookmark's description here. */
  meta_info?: Record<string, unknown>;
  /** Set by the Firefox and Safari readers when the browser stores a description. */
  description?: string;
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
  return chromiumBase("chrome", platform, env);
}

/**
 * The bookmarks file to read: MNEMOS_BOOKMARKS_PATH (or CHROME_BOOKMARKS_PATH)
 * if set, else the file of the browser --browser or MNEMOS_BOOKMARKS_BROWSER
 * names (Chrome by default), in the profile --profile, MNEMOS_PROFILE or
 * CHROME_PROFILE names (the browser's default when none is set). `options`
 * defaults to the startup flags.
 */
export function bookmarksPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options?: StartupOptions,
): string {
  const override = bookmarksPathOverride(env);
  if (override) return override;
  const browser = selectedBrowser(env, options);
  const profile = selectedProfile(env, options);
  if (browser === "firefox") return firefoxPlacesPath(profile, platform, env);
  if (browser === "safari") return safariBookmarksPath();
  return chromiumBookmarksPath(browser, profile, platform, env);
}

/** The first 16 bytes of a file: enough to tell SQLite and plist files from JSON. */
function readHead(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    return head.subarray(0, fs.readSync(fd, head, 0, 16, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** The error for a bookmarks file that cannot be read, naming where to look instead. */
function unreadable(browser: Browser, file: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  let message: string;
  if (browser === "safari" && (code === "EPERM" || code === "EACCES")) {
    message =
      `macOS did not let mnemos read ${file}. Safari's bookmarks are readable only by apps ` +
      "with Full Disk Access: add the app that runs mnemos (your terminal or MCP client) in " +
      "System Settings › Privacy & Security › Full Disk Access, then restart it.";
  } else if (code !== "ENOENT") {
    // The file is there (or something else is in its way): saying it is
    // missing would send the user looking for the wrong profile.
    const reason =
      code === "EISDIR"
        ? "the path is a directory, not a file"
        : code === "EACCES" || code === "EPERM"
          ? "the file exists, but permission was denied. Check its permissions, and whether " +
            "the app that runs mnemos (your terminal or MCP client, which may be sandboxed) " +
            "may read it"
          : error instanceof Error
            ? error.message
            : String(error);
    return new Error(`Cannot read the bookmarks file at ${file} (${code ?? "error"}): ${reason}.`);
  } else if (browser === "safari" && process.platform !== "darwin") {
    message = `No bookmarks file at ${file}: Safari keeps its bookmarks only on macOS.`;
  } else if (browser === "safari") {
    message = `No bookmarks file at ${file}. Set ${PATH_ENV} to a Safari Bookmarks.plist.`;
  } else if (browser === "firefox") {
    const available = firefoxProfilesWithBookmarks(firefoxBase());
    message =
      `No bookmarks file at ${file}. ` +
      `Firefox profiles that have bookmarks: ${available.join(", ") || "none"}. ` +
      `Choose one with --profile or ${PROFILE_ENV} (Firefox profile name), or set ${PATH_ENV}.`;
  } else {
    const available = chromiumProfiles(browser);
    message =
      `No bookmarks file at ${file}. ` +
      `${BROWSER_NAMES[browser]} profiles that have bookmarks: ${available.join(", ") || "none"}. ` +
      `Choose one with --profile or ${PROFILE_ENV} (profile directory name), or set ${PATH_ENV}.`;
  }
  const others = browsersWithBookmarks(browser);
  if (others.length > 0) {
    message +=
      ` Other browsers with bookmarks here: ${others.map((b) => BROWSER_NAMES[b]).join(", ")}` +
      ` (choose one with --browser or ${BROWSER_ENV}: ${others.join(", ")}).`;
  }
  return new Error(message);
}

/**
 * The root folders of the bookmarks file, keyed by root name. The file's
 * format is read from its first bytes, so MNEMOS_BOOKMARKS_PATH can point at
 * any supported browser's file: Chromium JSON, Firefox's places.sqlite or
 * Safari's binary Bookmarks.plist.
 */
export function loadRoots(): Record<string, BookmarkNode> {
  const browser = selectedBrowser();
  const file = bookmarksPath();
  let head: Buffer;
  try {
    head = readHead(file);
  } catch (e) {
    throw unreadable(browser, file, e);
  }
  if (isSqlite(head)) return readFirefoxRoots(file);
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (e) {
    throw unreadable(browser, file, e);
  }
  if (isBinaryPlist(head)) return readSafariRoots(file, data);
  if (data.toString("latin1", 0, 5) === "<?xml") {
    throw new Error(
      `File at ${file} is not a binary property list. Safari writes Bookmarks.plist in ` +
        "binary form; convert an XML copy with `plutil -convert binary1 <file>`.",
    );
  }
  // Chromium JSON. A bookmarks file read through MNEMOS_BOOKMARKS_PATH is
  // named after the selected browser, which is Chrome unless set otherwise.
  const name = isChromium(browser) ? BROWSER_NAMES[browser] : "The browser";
  let parsed: unknown;
  try {
    // A leading byte order mark, which Windows editors write, is not JSON;
    // Chrome never writes one, so it is dropped rather than read as mid-write.
    parsed = JSON.parse(data.toString("utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(
      `Bookmarks file at ${file} is not valid JSON (${e}). ` +
        `${name} may be mid-write; retry in a moment.`,
    );
  }
  // Valid JSON is not enough: pointing MNEMOS_BOOKMARKS_PATH at the wrong file
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
        `bookmark folders. Point ${PATH_ENV} at a Chromium browser's 'Bookmarks' ` +
        "file (no extension), Firefox's places.sqlite or Safari's Bookmarks.plist, or choose " +
        `a profile with --profile or ${PROFILE_ENV} instead.`,
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

// Chrome writes `type` on every node, but MNEMOS_BOOKMARKS_PATH accepts any
// file, and hand-made or third-party exports sometimes omit it. Falling back
// to the node's shape means a missing `type` can never silently drop a whole
// subtree of the user's bookmarks.
function isUrlNode(node: BookmarkNode): boolean {
  return node.type === "url" || (node.type === undefined && typeof node.url === "string");
}

function isFolderNode(node: BookmarkNode): boolean {
  return node.type === "folder" || (node.type === undefined && Array.isArray(node.children));
}

// Vivaldi keeps deleted bookmarks in a Trash folder inside the bookmark tree,
// marked in its meta_info. They are not bookmarks the user still keeps.
function isTrash(node: BookmarkNode): boolean {
  return node.meta_info?.Trash === "true";
}

/**
 * The description the browser stores for a bookmark, if any: Vivaldi's
 * meta_info.Description, or what the Firefox and Safari readers found.
 */
export function describe(node: BookmarkNode): string | undefined {
  const value = node.description ?? node.meta_info?.Description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const children = Array.isArray(node.children) ? node.children : [];
    // Pushed in reverse so siblings pop in document order.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      // A hand-edited or third-party file can hold null (or a bare string) in
      // a children array: skip it rather than fail the whole tool call.
      if (!isRecord(child)) continue;
      if (isUrlNode(child)) {
        stack.push({ node: child, folder });
      } else if (isFolderNode(child) && !isTrash(child)) {
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
    if (root && typeof root === "object" && isFolderNode(root) && !isTrash(root)) {
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

/** The query's words, lower-cased: what searchBookmarks and semantic search match. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * A test for search_bookmarks' rule: every word matches (as in queryMatches)
 * the bookmark's title, URL, folder path or description. No words match nothing.
 */
export function keywordMatcher(words: string[]): (entry: Entry) => boolean {
  const patterns = words.map(wordStart);
  return (entry) => {
    if (patterns.length === 0) return false;
    const { name = "", url = "" } = entry.node;
    const haystack = `${name} ${url} ${entry.folder} ${describe(entry.node) ?? ""}`.toLowerCase();
    return patterns.every((p) => p.test(haystack));
  };
}

// Titles and URLs are unbounded in the source file, and a single bookmark
// carrying a giant title or a data: URI should not be able to blow up a tool
// result. 2048 is past any real navigable URL, so live links are never
// mangled — only junk gets clipped.
const MAX_TITLE = 500;
const MAX_URL = 2048;
const MAX_DESCRIPTION = 1000;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function fmt(entry: Entry) {
  const description = describe(entry.node);
  return {
    title: clip(entry.node.name ?? "", MAX_TITLE),
    url: clip(entry.node.url ?? "", MAX_URL),
    folder: entry.folder,
    added: chromeTimeToIso(entry.node.date_added),
    // Only browsers that store one have it, so it is left out rather than
    // repeated as null on every Chrome bookmark.
    ...(description === undefined ? {} : { description: clip(description, MAX_DESCRIPTION) }),
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
  const words = queryWords(query);
  if (words.length === 0) {
    throw new Error(
      "Empty query. Provide one or more search words, or use " +
        "list_folders / recent_bookmarks to browse instead.",
    );
  }
  // The filter is optional, so a blank one means "no filter" rather than an
  // error — unlike list_folder_contents, where the folder is the whole request.
  const filter = folder?.trim() ? folder : undefined;
  const matches = [];
  const matchesQuery = keywordMatcher(words);
  for (const entry of allBookmarks()) {
    if (filter && !folderMatches(entry.folder, filter)) continue;
    if (matchesQuery(entry)) {
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
    throw new Error("Empty folder name. Call list_folders to see available folders.");
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
  const returned = items.slice(0, cap(limit, 100));
  const dated = returned.filter((i) => i.added > 0).length;
  // Safari stores no date for ordinary bookmarks (only Reading List items have
  // one), so undated bookmarks come back in file order, Favorites first. Say
  // so, or that order reads as what the user is focused on now.
  let note: string | undefined;
  if (returned.length > 0 && dated === 0) {
    note =
      "The browser stores no date added for these bookmarks, so they are in the " +
      "bookmarks file's order, not newest first: this list does not show what the " +
      "user added recently.";
  } else if (dated < returned.length) {
    note =
      `Only ${dated} of these ${returned.length} bookmarks ${dated === 1 ? "has" : "have"} ` +
      "a date added; the rest (added: null) follow in the bookmarks file's order, " +
      "not by recency.";
  }
  return {
    total_matches: items.length,
    bookmarks: returned.map((i) => fmt(i.entry)),
    ...(note === undefined ? {} : { note }),
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
