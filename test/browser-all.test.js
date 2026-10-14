// --browser all over every profile (src/sources.ts, src/lib.ts): every
// profile with bookmarks of every browser, each browser's default profile
// first; folder paths prefixed with the browser's name, then the profile's
// when a browser has several; a source that cannot be read is a warning;
// top_domains and semantic_search count a URL saved in several sources once;
// MNEMOS_BOOKMARKS_PATH reading any format by its first bytes; and parsed
// bookmarks files kept until they change. Each test points every platform's
// home variable at a fresh temp dir, so the browsers' default paths land inside it.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";
import { selectSources } from "../dist/sources.js";
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer } from "../dist/indexer.js";
import { semanticSearch } from "../dist/semantic.js";

let sqlite;
try {
  sqlite = createRequire(import.meta.url)("node:sqlite");
} catch {
  // Node before 22.13: the places.sqlite tests skip.
}
const needsSqlite = { skip: sqlite ? false : "node:sqlite needs Node 22.13 or later" };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = path.join(ROOT, "dist", "index.js");
const SAFARI_FIXTURE = path.join(ROOT, "test", "fixtures", "safari-bookmarks.plist");

const SELECTION_VARS = [
  "CHROME_BOOKMARKS_PATH",
  "CHROME_PROFILE",
  "MNEMOS_BOOKMARKS_PATH",
  "MNEMOS_PROFILE",
  "MNEMOS_BOOKMARKS_BROWSER",
];

let home;
const dirs = [];

function homeEnv() {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-all-"));
  dirs.push(home);
  Object.assign(process.env, homeEnv());
  for (const name of SELECTION_VARS) delete process.env[name];
});

afterEach(() => browsers.setStartupOptions({}));

after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

function write(file, data) {
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const chromiumFile = (...bookmarks) =>
  JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "",
        children: bookmarks.map(([name, url]) => ({ type: "url", name, url, date_added: "13350000000000000" })),
      },
    },
  });

/** A Chromium browser's profile with these bookmarks; returns its Bookmarks file. */
function makeProfile(browser, profile, ...bookmarks) {
  const file = path.join(browsers.chromiumBase(browser), profile, "Bookmarks");
  write(file, chromiumFile(...bookmarks));
  return file;
}

/** A Chromium browser's Local State: the last-used profile and each profile's display name. */
function localState(browser, lastUsed, names) {
  const info_cache = Object.fromEntries(Object.entries(names).map(([dir, name]) => [dir, { name }]));
  write(
    path.join(browsers.chromiumBase(browser), "Local State"),
    JSON.stringify({ profile: { ...(lastUsed ? { last_used: lastUsed } : {}), info_cache } }),
  );
}

/** A places.sqlite with these bookmarks on Firefox's toolbar. */
function makePlaces(file, ...bookmarks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, description TEXT);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
      parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER,
      lastModified INTEGER, guid TEXT);
  `);
  const mark = db.prepare(
    "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  mark.run(1, 2, null, 0, 0, "", 0, "root________");
  mark.run(2, 2, null, 1, 0, "toolbar", 0, "toolbar_____");
  const place = db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)");
  bookmarks.forEach(([name, url], i) => {
    place.run(10 + i, url, name);
    mark.run(10 + i, 1, 10 + i, 2, i, name, 1_700_000_000_000_000, `bm-${i}`);
  });
  db.close();
  return file;
}

/** Firefox with these profiles ([name, directory, bookmarks…]), the first its default; returns each places.sqlite. */
function makeFirefox(...profiles) {
  const base = browsers.firefoxBase();
  const ini = profiles.flatMap(([name, dir], i) => [
    `[Profile${i}]`,
    `Name=${name}`,
    "IsRelative=1",
    `Path=Profiles/${dir}`,
    ...(i === 0 ? ["Default=1"] : []),
    "",
  ]);
  write(path.join(base, "profiles.ini"), ini.join("\n"));
  return profiles.map(([, dir, ...bookmarks]) => makePlaces(path.join(base, "Profiles", dir, "places.sqlite"), ...bookmarks));
}

// ---------------------------------------------------------------------------
// Every profile, and the folder path prefixes
// ---------------------------------------------------------------------------

test("all: every profile of every browser, the default first; the profile is in the path when a browser has several", needsSqlite, () => {
  const personal = makeProfile("chrome", "Default", ["Recipes", "https://food.example/"]);
  const work = makeProfile("chrome", "Profile 1", ["Roadmap", "https://work.example/roadmap"]);
  localState("chrome", "Profile 1", { Default: "Personal", "Profile 1": "Work" });
  const edge = makeProfile("edge", "Default", ["Edge page", "https://edge.example/"]);
  const [release, dev] = makeFirefox(
    ["default-release", "aaaa.default-release", ["Mozilla", "https://www.mozilla.org/"]],
    ["dev", "bbbb.dev", ["Nightly notes", "https://nightly.example/"]],
  );
  // A profile directory without bookmarks is not a source.
  fs.mkdirSync(path.join(browsers.chromiumBase("chrome"), "Profile 2"), { recursive: true });

  browsers.setStartupOptions({ browser: "all" });
  const selection = selectSources();
  assert.deepEqual(selection.sources, [
    { browser: "chrome", profile: "Work (Profile 1)", bookmarks: work },
    { browser: "chrome", profile: "Personal (Default)", bookmarks: personal },
    { browser: "edge", profile: "Default", bookmarks: edge },
    { browser: "firefox", profile: "default-release (aaaa.default-release)", bookmarks: release },
    { browser: "firefox", profile: "dev (bbbb.dev)", bookmarks: dev },
  ]);
  assert.deepEqual(selection.prefixes, [
    "Chrome › Work › ",
    "Chrome › Personal › ",
    "Edge › ",
    "Firefox › default-release › ",
    "Firefox › dev › ",
  ]);

  const folders = lib.listFolders();
  assert.deepEqual(folders.folders.map((f) => f.folder), [
    "Chrome › Personal › Bookmarks Bar",
    "Chrome › Work › Bookmarks Bar",
    "Edge › Bookmarks Bar",
    "Firefox › default-release › Bookmarks Toolbar",
    "Firefox › dev › Bookmarks Toolbar",
  ]);
  assert.equal(folders.total_bookmarks, 5);
  assert.deepEqual(folders.sources, selection.sources);
  assert.equal("warnings" in folders, false);
  // The profile's name is a folder segment like any other: the filters match it.
  assert.deepEqual(lib.listFolderContents("work").bookmarks.map((b) => b.title), ["Roadmap"]);
  assert.deepEqual(lib.searchBookmarks("notes", "dev").matches.map((b) => b.folder), ["Firefox › dev › Bookmarks Toolbar"]);

  // A list still reads each browser's default profile only.
  browsers.setStartupOptions({ browser: ["chrome", "firefox"] });
  assert.deepEqual(selectSources().sources.map((s) => s.bookmarks), [work, release]);
  assert.deepEqual(selectSources().prefixes, ["Chrome › ", "Firefox › "]);
});

test("all: profiles with the same name are told apart by their directories", () => {
  makeProfile("chrome", "Default", ["one", "https://one.example/"]);
  makeProfile("chrome", "Profile 3", ["three", "https://three.example/"]);
  makeProfile("brave", "Default", ["brave", "https://brave.example/"]);
  localState("chrome", undefined, { Default: "Work", "Profile 3": "Work" });
  browsers.setStartupOptions({ browser: "all" });
  assert.deepEqual(selectSources().prefixes, ["Chrome › Work (Default) › ", "Chrome › Work (Profile 3) › ", "Brave › "]);
});

test("all: Opera's root-level Bookmarks file is its Default profile, beside its other profiles", () => {
  const base = browsers.chromiumBase("opera");
  write(path.join(base, "Bookmarks"), chromiumFile(["root", "https://root.example/"]));
  const other = makeProfile("opera", "Profile 1", ["other", "https://other.example/"]);
  browsers.setStartupOptions({ browser: "all" });
  assert.deepEqual(selectSources().sources, [
    { browser: "opera", profile: "Default", bookmarks: path.join(base, "Bookmarks") },
    { browser: "opera", profile: "Profile 1", bookmarks: other },
  ]);
});

// ---------------------------------------------------------------------------
// A source that cannot be read
// ---------------------------------------------------------------------------

test("all: a profile that cannot be read is a warning naming it; the rest are read", needsSqlite, () => {
  const good = makeProfile("chrome", "Default", ["Recipes", "https://food.example/"]);
  const broken = makeProfile("chrome", "Profile 2", ["x", "https://x.example/"]);
  fs.writeFileSync(broken, "{ not json");
  const edge = makeProfile("edge", "Default", ["Edge page", "https://edge.example/"]);
  // Firefox's one profile holds something that is not a database.
  const [places] = makeFirefox(["default-release", "aaaa.default-release"]);
  fs.writeFileSync(places, "junk, not a database");

  browsers.setStartupOptions({ browser: "all" });
  for (const result of [lib.listFolders(), lib.topDomains(), lib.recentBookmarks(), lib.searchBookmarks("page")]) {
    assert.deepEqual(result.sources, [
      { browser: "chrome", profile: "Default", bookmarks: good },
      { browser: "edge", profile: "Default", bookmarks: edge },
    ]);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0], /^Chrome › Profile 2: Bookmarks file at .* is not valid JSON/);
    assert.match(result.warnings[1], /^Firefox: File at .*places\.sqlite is not a bookmarks file mnemos can read/);
  }
  assert.deepEqual(lib.listFolders().folders.map((f) => f.folder), ["Chrome › Default › Bookmarks Bar", "Edge › Bookmarks Bar"]);
});

test("all: Safari's bookmarks unreadable without Full Disk Access is a warning, not an error", { skip: process.platform !== "darwin" || process.getuid?.() === 0 ? "macOS, not as root" : false }, () => {
  const safari = path.join(home, "Library", "Safari", "Bookmarks.plist");
  write(safari, fs.readFileSync(SAFARI_FIXTURE));
  fs.chmodSync(safari, 0o000);
  try {
    makeProfile("chrome", "Default", ["Recipes", "https://food.example/"]);
    browsers.setStartupOptions({ browser: "all" });
    const result = lib.listFolders();
    assert.deepEqual(result.sources.map((s) => s.browser), ["chrome"]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Safari: macOS did not let mnemos read .*Full Disk Access/);
  } finally {
    fs.chmodSync(safari, 0o644);
  }
});

// ---------------------------------------------------------------------------
// A URL saved in several sources counts once
// ---------------------------------------------------------------------------

test("top_domains: a URL saved in several sources counts once; one source's own repeats still count", () => {
  makeProfile(
    "chrome",
    "Default",
    ["Docs", "https://docs.example/a"],
    ["Docs again", "https://docs.example/a"],
    ["Other doc", "https://docs.example/b"],
  );
  makeProfile("chrome", "Profile 1", ["Docs", "https://docs.example/a"], ["News", "https://news.example/"]);
  makeProfile("edge", "Default", ["Docs", "https://docs.example/a"], ["News", "https://www.news.example/"]);
  browsers.setStartupOptions({ browser: "all" });
  const result = lib.topDomains();
  assert.deepEqual(result.domains, [
    { domain: "docs.example", bookmarks: 3 },
    { domain: "news.example", bookmarks: 2 },
  ]);
  assert.equal(result.total_matches, 2);
  // One source alone counts as it always has.
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.deepEqual(lib.topDomains().domains, [{ domain: "docs.example", bookmarks: 3 }]);
});

test("semantic_search: a URL saved in several sources is one result, from the best-ranked source", async () => {
  makeProfile("chrome", "Default", ["Sourdough starter", "https://bread.example/sourdough"], ["Taxes", "https://tax.example/"]);
  makeProfile("edge", "Default", ["Starter for sourdough", "https://bread.example/sourdough"], ["Trains", "https://rail.example/"]);
  browsers.setStartupOptions({ browser: "all" });
  const cache = path.join(home, "cache");
  const embedder = new FakeEmbedder();
  const made = new Map();
  const indexes = (source) => {
    if (!made.has(source.bookmarks)) {
      const indexer = new Indexer({ embedder, bookmarksFile: () => source.bookmarks, entries: () => lib.sourceBookmarks(source), dir: cache });
      indexer.start();
      made.set(source.bookmarks, { indexer });
    }
    return made.get(source.bookmarks);
  };
  try {
    await semanticSearch({ embedder, indexes, env: {} }, "anything");
    for (const { indexer } of made.values()) await indexer.idle();
    const data = await semanticSearch({ embedder, indexes, env: {} }, "sourdough");
    const bread = data.results.filter((r) => r.url === "https://bread.example/sourdough");
    assert.equal(bread.length, 1, JSON.stringify(data.results));
    assert.equal(bread[0].matched_on, "keyword");
    assert.equal(data.count_above_threshold, data.results.length);
    assert.equal(data.sources.length, 2);
    // Keyword-only answers (the model not ready) are deduplicated too.
    const keywordOnly = await semanticSearch(
      { embedder: Object.assign(Object.create(embedder), { status: () => ({ state: "loading" }) }), indexes, env: {} },
      "sourdough",
    );
    assert.equal(keywordOnly.status.search, "keyword");
    assert.deepEqual(keywordOnly.results.map((r) => r.folder), ["Chrome › Bookmarks Bar"]);
    assert.equal(keywordOnly.count_above_threshold, 1);
  } finally {
    for (const { indexer } of made.values()) indexer.close();
  }
});

// ---------------------------------------------------------------------------
// MNEMOS_BOOKMARKS_PATH: the format from the first bytes
// ---------------------------------------------------------------------------

test("MNEMOS_BOOKMARKS_PATH: JSON, SQLite and binary plist files are read by their first bytes, whatever their names", needsSqlite, () => {
  const json = path.join(home, "export.dat");
  write(json, chromiumFile(["Chromium page", "https://json.example/"]));
  const db = makePlaces(path.join(home, "backup.bin"), ["Firefox page", "https://sqlite.example/"]);
  const plist = path.join(home, "safari-copy");
  write(plist, fs.readFileSync(SAFARI_FIXTURE));
  const read = (file) => {
    process.env.MNEMOS_BOOKMARKS_PATH = file;
    return lib.listFolders();
  };
  assert.deepEqual(read(json).folders.map((f) => f.folder), ["Bookmarks Bar"]);
  assert.deepEqual(read(db).folders.map((f) => f.folder), ["Bookmarks Toolbar"]);
  assert.deepEqual(read(json).sources, [{ browser: null, profile: null, bookmarks: json }]);
  const safari = read(plist);
  assert.ok(safari.total_bookmarks > 0);
  assert.ok(safari.folders.some((f) => f.folder === "Favorites"), JSON.stringify(safari.folders));
});

test("MNEMOS_BOOKMARKS_PATH: a file in no supported format says so, rather than 'mid-write'", () => {
  const text = path.join(home, "notes.txt");
  write(text, "Some notes, not bookmarks.");
  process.env.MNEMOS_BOOKMARKS_PATH = text;
  assert.throws(
    () => lib.listFolders(),
    { message: `File at ${text} is not a bookmarks file mnemos can read: it is neither a Chromium Bookmarks file (JSON), Firefox's places.sqlite (SQLite) nor Safari's Bookmarks.plist (binary property list). Point MNEMOS_BOOKMARKS_PATH at one of those.` },
  );
  // A JSON object cut short, or an empty file, may be one being written.
  write(text, "  {\"roots\": {");
  assert.throws(() => lib.listFolders(), /not valid JSON.*mid-write/s);
  write(text, "");
  assert.throws(() => lib.listFolders(), /not valid JSON.*mid-write/s);
});

// ---------------------------------------------------------------------------
// Parsed files kept until they change
// ---------------------------------------------------------------------------

test("cache: an unchanged file is parsed once; a changed one is read again", () => {
  const file = makeProfile("chrome", "Default", ["one", "https://one.example/"]);
  const source = { browser: "chrome", profile: "Default", bookmarks: file };
  const first = lib.sourceRoots(source);
  assert.equal(lib.sourceRoots(source), first, "unchanged: the same parse");
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.equal(lib.readBookmarks().read[0].roots, first, "tool calls share it");

  // Chrome replaces the file to write it: new size, new content.
  write(file, chromiumFile(["one", "https://one.example/"], ["two", "https://two.example/"]));
  const second = lib.sourceRoots(source);
  assert.notEqual(second, first);
  assert.equal(second.bookmark_bar.children.length, 2);
  // The same size with an older modification time is still a change.
  const stat = fs.statSync(file);
  write(file, chromiumFile(["one", "https://one.example/"], ["owt", "https://owt.example/"]));
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs - 60_000));
  assert.equal(lib.sourceRoots(source).bookmark_bar.children[1].name, "owt");
});

test("cache: a file that cannot be read is tried again on the next call", () => {
  const file = path.join(browsers.chromiumBase("chrome"), "Default", "Bookmarks");
  const source = { browser: "chrome", profile: "Default", bookmarks: file };
  assert.throws(() => lib.sourceRoots(source), /No bookmarks file at /);
  write(file, chromiumFile(["one", "https://one.example/"]));
  assert.equal(lib.sourceRoots(source).bookmark_bar.children.length, 1);
  write(file, "{ not json, but longer than the last file was");
  assert.throws(() => lib.sourceRoots(source), /not valid JSON/);
  assert.throws(() => lib.sourceRoots(source), /not valid JSON/, "an error is not kept as a parse");
});

test("cache: Firefox's database is copied and read again only when it or its WAL changes", needsSqlite, () => {
  const [places] = makeFirefox(["default-release", "aaaa.default-release", ["Mozilla", "https://www.mozilla.org/"]]);
  const source = { browser: "firefox", profile: null, bookmarks: places };
  const first = lib.sourceRoots(source);
  assert.equal(lib.sourceRoots(source), first);
  // Firefox's recent writes land in places.sqlite-wal.
  write(`${places}-wal`, "");
  assert.notEqual(lib.sourceRoots(source), first);
});

// ---------------------------------------------------------------------------
// Over MCP
// ---------------------------------------------------------------------------

test("e2e: --browser all reads every profile and names each in the folder paths", async () => {
  const personal = makeProfile("chrome", "Default", ["Rust book", "https://doc.rust-lang.org/book/"]);
  const work = makeProfile("chrome", "Profile 1", ["Rust book", "https://doc.rust-lang.org/book/"]);
  localState("chrome", "Default", { Default: "Personal", "Profile 1": "Work" });
  const env = { ...process.env, MNEMOS_EMBEDDER: "fake", MNEMOS_FETCH_PAGES: "0", MNEMOS_CACHE_DIR: path.join(home, "cache"), ...homeEnv() };
  for (const name of SELECTION_VARS) delete env[name];
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, "--browser", "all"], env }));
  try {
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text);
    };
    const search = await call("search_bookmarks", { query: "rust" });
    assert.deepEqual(search.matches.map((m) => m.folder), ["Chrome › Personal › Bookmarks Bar", "Chrome › Work › Bookmarks Bar"]);
    assert.deepEqual(search.sources, [
      { browser: "chrome", profile: "Personal (Default)", bookmarks: personal },
      { browser: "chrome", profile: "Work (Profile 1)", bookmarks: work },
    ]);
    assert.deepEqual((await call("top_domains")).domains, [{ domain: "doc.rust-lang.org", bookmarks: 1 }]);
    assert.equal((await call("semantic_search", { query: "rust" })).count_above_threshold, 1);
  } finally {
    await client.close();
  }
});
