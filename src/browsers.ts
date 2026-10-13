/**
 * Where each supported browser keeps its bookmarks, and readers for the
 * formats that are not Chrome's JSON. Chromium-based browsers (Chrome,
 * Chromium, Edge, Brave, Vivaldi) all write the same `Bookmarks` JSON file,
 * which lib.ts parses; Firefox keeps bookmarks in the `places.sqlite` database
 * and Safari in a binary `Bookmarks.plist`. Both readers convert to the
 * Chrome-shaped BookmarkNode tree, so every tool works on every browser.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BookmarkNode } from "./lib.js";
import { parseBinaryPlist } from "./plist.js";

/** The environment variable choosing the browser. MNEMOS_BROWSER is taken. */
export const BROWSER_ENV = "MNEMOS_BOOKMARKS_BROWSER";

export const BROWSERS = ["chrome", "chromium", "edge", "brave", "vivaldi", "firefox", "safari"] as const;
export type Browser = (typeof BROWSERS)[number];
type ChromiumBrowser = Exclude<Browser, "firefox" | "safari">;

export const BROWSER_NAMES: Record<Browser, string> = {
  chrome: "Chrome",
  chromium: "Chromium",
  edge: "Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  firefox: "Firefox",
  safari: "Safari",
};

/** The browser named by MNEMOS_BOOKMARKS_BROWSER; Chrome when it is unset or empty. */
export function selectedBrowser(env: NodeJS.ProcessEnv = process.env): Browser {
  const value = (env[BROWSER_ENV] ?? "").trim().toLowerCase();
  if (!value) return "chrome";
  if ((BROWSERS as readonly string[]).includes(value)) return value as Browser;
  throw new Error(`${BROWSER_ENV} is "${env[BROWSER_ENV]}"; use one of: ${BROWSERS.join(", ")}.`);
}

export function isChromium(browser: Browser): browser is ChromiumBrowser {
  return browser !== "firefox" && browser !== "safari";
}

// The user-data directory of each Chromium-based browser, below the platform's
// application-data directory, per platform.
const CHROMIUM_DIRS: Record<ChromiumBrowser, Record<"darwin" | "win32" | "linux", string[]>> = {
  chrome: {
    darwin: ["Google", "Chrome"],
    win32: ["Google", "Chrome", "User Data"],
    linux: ["google-chrome"],
  },
  chromium: { darwin: ["Chromium"], win32: ["Chromium", "User Data"], linux: ["chromium"] },
  edge: {
    darwin: ["Microsoft Edge"],
    win32: ["Microsoft", "Edge", "User Data"],
    linux: ["microsoft-edge"],
  },
  brave: {
    darwin: ["BraveSoftware", "Brave-Browser"],
    win32: ["BraveSoftware", "Brave-Browser", "User Data"],
    linux: ["BraveSoftware", "Brave-Browser"],
  },
  vivaldi: { darwin: ["Vivaldi"], win32: ["Vivaldi", "User Data"], linux: ["vivaldi"] },
};

export function chromiumBase(
  browser: ChromiumBrowser,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dirs = CHROMIUM_DIRS[browser];
  switch (platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", ...dirs.darwin);
    // `||`, not `??`: an env var set to the empty string means "unset" (the
    // XDG spec says so explicitly), and `??` would let it through and build a
    // relative path that silently resolves against the process's cwd.
    case "win32":
      return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), ...dirs.win32);
    default: // linux and other unixes
      return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), ...dirs.linux);
  }
}

/** Chromium profile directories under `base` that hold a Bookmarks file, sorted. */
export function chromiumProfilesWithBookmarks(base: string): string[] {
  try {
    return fs
      .readdirSync(base)
      .filter((d) => fs.existsSync(path.join(base, d, "Bookmarks")))
      .sort();
  } catch {
    return []; // base dir itself missing
  }
}

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

/**
 * The Firefox directory holding profiles.ini. Linux has several: the classic
 * ~/.mozilla/firefox, the XDG location newer Firefox uses for new installs,
 * and the Snap and Flatpak sandboxes. The first one with a profiles.ini wins.
 */
export function firefoxBase(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = os.homedir();
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Firefox");
    case "win32":
      return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Mozilla", "Firefox");
    default: {
      const candidates = [
        path.join(home, ".mozilla", "firefox"),
        path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "mozilla", "firefox"),
        path.join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
        path.join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
      ];
      return candidates.find((c) => fs.existsSync(path.join(c, "profiles.ini"))) ?? candidates[0];
    }
  }
}

export interface FirefoxProfile {
  /** The name Firefox shows in about:profiles. */
  name: string;
  /** The profile's directory. */
  dir: string;
  /** True for the profile Firefox opens by default. */
  isDefault: boolean;
}

/**
 * The profiles listed in `<base>/profiles.ini`, in file order; empty when
 * there is no such file. The default is the one an [Install…] section names
 * (what current Firefox opens), else the [Profile…] marked Default=1.
 */
export function firefoxProfiles(base: string): FirefoxProfile[] {
  let ini: string;
  try {
    ini = fs.readFileSync(path.join(base, "profiles.ini"), "utf-8");
  } catch {
    return [];
  }
  const sections: { name: string; keys: Record<string, string> }[] = [];
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      sections.push({ name: header[1], keys: {} });
    } else if (sections.length > 0 && line.includes("=")) {
      const at = line.indexOf("=");
      sections[sections.length - 1].keys[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  const installDefault = sections.find((s) => s.name.startsWith("Install") && s.keys.Default)?.keys
    .Default;
  const listed = sections
    .filter((s) => /^Profile\d+$/.test(s.name) && s.keys.Path)
    .map((s) => ({
      name: s.keys.Name ?? path.basename(s.keys.Path),
      path: s.keys.Path,
      dir: s.keys.IsRelative === "0" ? s.keys.Path : path.join(base, s.keys.Path),
      marked: s.keys.Default === "1",
    }));
  const chosen = listed.find((p) => p.path === installDefault) ?? listed.find((p) => p.marked);
  return listed.map((p) => ({ name: p.name, dir: p.dir, isDefault: p === chosen }));
}

/**
 * places.sqlite of the Firefox profile named by CHROME_PROFILE (its name or
 * its directory's name), or of the default profile.
 */
export function firefoxPlacesPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = firefoxBase(platform, env);
  const profiles = firefoxProfiles(base);
  if (profiles.length === 0) {
    throw new Error(
      `No Firefox profiles found: no profiles.ini in ${base}. ` +
        "Set CHROME_BOOKMARKS_PATH to a Firefox places.sqlite file.",
    );
  }
  const wanted = env.CHROME_PROFILE;
  const profile = wanted
    ? (profiles.find((p) => p.name === wanted || path.basename(p.dir) === wanted) ??
      profiles.find((p) => p.name.toLowerCase() === wanted.toLowerCase()))
    : (profiles.find((p) => p.isDefault) ?? profiles[0]);
  if (!profile) {
    throw new Error(
      `No Firefox profile named "${wanted}" in ${path.join(base, "profiles.ini")}. ` +
        `Firefox profiles that have bookmarks: ${firefoxProfilesWithBookmarks(base).join(", ") || "none"}. ` +
        "Set CHROME_PROFILE (Firefox profile name) or CHROME_BOOKMARKS_PATH.",
    );
  }
  return path.join(profile.dir, "places.sqlite");
}

/** Names of the Firefox profiles under `base` that have a places.sqlite, sorted. */
export function firefoxProfilesWithBookmarks(base: string): string[] {
  return firefoxProfiles(base)
    .filter((p) => fs.existsSync(path.join(p.dir, "places.sqlite")))
    .map((p) => p.name)
    .sort();
}

export function isSqlite(head: Buffer): boolean {
  return head.length >= 16 && head.toString("latin1", 0, 16) === "SQLite format 3\0";
}

const require = createRequire(import.meta.url);

function openDatabase(file: string): DatabaseSync {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = require("node:sqlite");
  } catch {
    throw new Error(
      `Reading Firefox bookmarks needs Node 22.13 or later (for node:sqlite); ` +
        `this is Node ${process.versions.node}.`,
    );
  }
  return new sqlite.DatabaseSync(file);
}

// Firefox's built-in root folders, by their fixed GUIDs. The tags root is not
// a folder of bookmarks — it holds one folder per tag — so it is left out.
const FIREFOX_ROOTS: Record<string, string> = {
  "menu________": "Bookmarks Menu",
  "toolbar_____": "Bookmarks Toolbar",
  "unfiled_____": "Other Bookmarks",
  "mobile______": "Mobile Bookmarks",
};
const FIREFOX_TAGS_ROOT = "tags________";

/** Microseconds between 1601-01-01 (Chrome's epoch) and 1970-01-01. */
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

/** A Unix time in microseconds as a Chrome `date_added` string. */
export function unixMicrosToChrome(micros: number): string | undefined {
  if (!Number.isFinite(micros) || micros <= 0) return undefined;
  return String(BigInt(Math.trunc(micros)) + CHROME_EPOCH_OFFSET_US);
}

interface PlacesRow {
  id: number;
  type: number;
  parent: number;
  title: string | null;
  added: number | null;
  guid: string | null;
  url: string | null;
  page_title: string | null;
  description: string | null;
}

let placesCache: { key: string; roots: Record<string, BookmarkNode> } | undefined;

/**
 * The bookmark roots of a Firefox places.sqlite. Firefox keeps the database
 * open and locked while it runs, and recent writes sit in places.sqlite-wal,
 * so the database and its WAL are copied to a temporary directory and the
 * copy is read. The result is cached until either file changes.
 */
export function readFirefoxRoots(file: string): Record<string, BookmarkNode> {
  const wal = `${file}-wal`;
  const stamp = (f: string) => {
    try {
      const s = fs.statSync(f);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "-";
    }
  };
  const key = `${file}\0${stamp(file)}\0${stamp(wal)}`;
  if (placesCache?.key === key) return placesCache.roots;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-places-"));
  try {
    const copy = path.join(dir, "places.sqlite");
    // COPYFILE_FICLONE clones copy-on-write where the filesystem can (APFS,
    // Btrfs), and falls back to a plain copy elsewhere.
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_FICLONE);
    if (fs.existsSync(wal)) fs.copyFileSync(wal, `${copy}-wal`, fs.constants.COPYFILE_FICLONE);
    const db = openDatabase(copy);
    let rows: PlacesRow[];
    try {
      rows = queryPlaces(db, file);
    } finally {
      db.close();
    }
    const roots = placesTree(rows);
    placesCache = { key, roots };
    return roots;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function queryPlaces(db: DatabaseSync, file: string): PlacesRow[] {
  const names = (sql: string) =>
    new Set(db.prepare(sql).all().map((r) => String((r as { name: unknown }).name)));
  let tables: Set<string>;
  try {
    tables = names("SELECT name FROM sqlite_master WHERE type = 'table'");
  } catch (e) {
    throw new Error(`Cannot read the Firefox database at ${file} (${e}).`);
  }
  if (!tables.has("moz_bookmarks") || !tables.has("moz_places")) {
    throw new Error(
      `File at ${file} is not a Firefox places.sqlite database: it has no moz_bookmarks ` +
        "and moz_places tables.",
    );
  }
  // Two places hold a description. Older Firefox kept the one the user typed
  // in the bookmark dialog as an item annotation; Firefox 61+ stores the
  // page's own meta description on moz_places. The user's wins.
  const pageDescription = names("PRAGMA table_info(moz_places)").has("description")
    ? "p.description"
    : "NULL";
  const userDescription =
    tables.has("moz_items_annos") && tables.has("moz_anno_attributes")
      ? `(SELECT a.content FROM moz_items_annos a
           JOIN moz_anno_attributes n ON n.id = a.anno_attribute_id
          WHERE a.item_id = b.id AND n.name = 'bookmarkProperties/description' LIMIT 1)`
      : "NULL";
  return db
    .prepare(
      `SELECT b.id, b.type, b.parent, b.title, b.dateAdded AS added, b.guid,
              p.url, p.title AS page_title,
              COALESCE(NULLIF(${userDescription}, ''), ${pageDescription}) AS description
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
        ORDER BY b.parent, b.position, b.id`,
    )
    .all() as unknown as PlacesRow[];
}

/** Build Chrome-shaped root folders from moz_bookmarks rows (1 = bookmark, 2 = folder). */
function placesTree(rows: PlacesRow[]): Record<string, BookmarkNode> {
  const children = new Map<number, BookmarkNode[]>();
  const folders: { row: PlacesRow; node: BookmarkNode }[] = [];
  for (const row of rows) {
    let node: BookmarkNode;
    if (row.type === 2) {
      node = { type: "folder", name: row.title ?? "", children: [] };
      folders.push({ row, node });
    } else if (row.type === 1 && row.url && !row.url.startsWith("place:")) {
      // place: URLs are saved history queries ("Most Visited"), not pages.
      node = { type: "url", name: row.title || row.page_title || "", url: row.url };
      const added = unixMicrosToChrome(Number(row.added));
      if (added) node.date_added = added;
      if (row.description) node.description = row.description;
    } else {
      continue; // separators, and bookmarks whose place row is gone
    }
    const siblings = children.get(row.parent);
    if (siblings) siblings.push(node);
    else children.set(row.parent, [node]);
  }
  for (const { row, node } of folders) node.children = children.get(row.id) ?? [];

  const root =
    folders.find((f) => f.row.guid === "root________") ?? folders.find((f) => f.row.parent === 0);
  const roots: Record<string, BookmarkNode> = Object.create(null);
  if (!root) return roots;
  for (const { row, node } of folders) {
    if (row.parent !== root.row.id || row.guid === FIREFOX_TAGS_ROOT) continue;
    addRoot(roots, FIREFOX_ROOTS[row.guid ?? ""] ?? (row.title || row.guid || String(row.id)), node);
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Safari
// ---------------------------------------------------------------------------

export function safariBookmarksPath(): string {
  return path.join(os.homedir(), "Library", "Safari", "Bookmarks.plist");
}

// Safari's built-in top-level folders, by their stored titles, under the
// names Safari's sidebar shows.
const SAFARI_ROOTS: Record<string, string> = {
  BookmarksBar: "Favorites",
  BookmarksMenu: "Bookmarks Menu",
  "com.apple.ReadingList": "Reading List",
};

/** Root for bookmarks stored at the top level, outside any folder. */
const SAFARI_LOOSE_ROOT = "Bookmarks";

/**
 * The bookmark roots of a Safari Bookmarks.plist: a tree of dicts whose
 * WebBookmarkType is a folder ("List"), a bookmark ("Leaf") or a link to
 * History ("Proxy", skipped). Reading List items carry the date they were
 * added and the page's preview text, which becomes the description.
 */
export function readSafariRoots(file: string, data: Buffer): Record<string, BookmarkNode> {
  let plist: unknown;
  try {
    plist = parseBinaryPlist(data);
  } catch (e) {
    throw new Error(`File at ${file} is not a valid binary property list (${(e as Error).message}).`);
  }
  if (!isRecord(plist) || !Array.isArray(plist.Children)) {
    throw new Error(
      `File at ${file} is not a Safari Bookmarks.plist: no top-level "Children" list.`,
    );
  }
  const roots: Record<string, BookmarkNode> = Object.create(null);
  const loose: BookmarkNode[] = [];
  for (const item of plist.Children) {
    const node = safariNode(item);
    if (!node) continue;
    if (node.type === "url") {
      loose.push(node);
      continue;
    }
    addRoot(roots, SAFARI_ROOTS[node.name ?? ""] ?? node.name ?? "", node);
  }
  if (loose.length > 0) addRoot(roots, SAFARI_LOOSE_ROOT, { type: "folder", children: loose });
  return roots;
}

function safariNode(item: unknown): BookmarkNode | undefined {
  if (!isRecord(item)) return undefined;
  if (item.WebBookmarkType === "WebBookmarkTypeList") {
    const kids = Array.isArray(item.Children) ? item.Children : [];
    return {
      type: "folder",
      name: typeof item.Title === "string" ? item.Title : "",
      children: kids.map(safariNode).filter((n): n is BookmarkNode => n !== undefined),
    };
  }
  if (item.WebBookmarkType !== "WebBookmarkTypeLeaf" || typeof item.URLString !== "string") {
    return undefined;
  }
  const uri = isRecord(item.URIDictionary) ? item.URIDictionary : {};
  const node: BookmarkNode = {
    type: "url",
    name: typeof uri.title === "string" ? uri.title : "",
    url: item.URLString,
  };
  const reading = isRecord(item.ReadingList) ? item.ReadingList : {};
  if (reading.DateAdded instanceof Date) {
    const added = unixMicrosToChrome(reading.DateAdded.getTime() * 1000);
    if (added) node.date_added = added;
  }
  if (typeof reading.PreviewText === "string" && reading.PreviewText) {
    node.description = reading.PreviewText;
  }
  return node;
}

/** Add a root under `label`, numbering it when two roots share a name. */
function addRoot(roots: Record<string, BookmarkNode>, label: string, node: BookmarkNode): void {
  let key = label;
  for (let n = 2; key in roots; n++) key = `${label} (${n})`;
  roots[key] = node;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Browsers other than `except` that have bookmarks on this machine. */
export function browsersWithBookmarks(
  except: Browser,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Browser[] {
  return BROWSERS.filter((browser) => {
    if (browser === except) return false;
    try {
      if (browser === "firefox") return firefoxProfilesWithBookmarks(firefoxBase(platform, env)).length > 0;
      if (browser === "safari") return platform === "darwin" && fs.existsSync(safariBookmarksPath());
      return chromiumProfilesWithBookmarks(chromiumBase(browser, platform, env)).length > 0;
    } catch {
      return false;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
