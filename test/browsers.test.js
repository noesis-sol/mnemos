// Reading bookmarks from browsers other than Chrome: MNEMOS_BOOKMARKS_BROWSER
// choosing Edge, Brave, Vivaldi, Chromium, Firefox or Safari; Firefox's
// places.sqlite read from a copy (WAL included); Safari's binary
// Bookmarks.plist; CHROME_BOOKMARKS_PATH accepting any of those formats; and
// descriptions, where the browser stores them, returned and searched. Like
// profiles.test.js, each test points every platform's home variable at a fresh
// temp dir, so the browsers' default paths land inside it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";

process.env.TZ = "UTC";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAFARI_FIXTURE = path.join(ROOT, "test", "fixtures", "safari-bookmarks.plist");

let sqlite;
try {
  sqlite = createRequire(import.meta.url)("node:sqlite");
} catch {
  // Node before 22.13: the Firefox tests skip.
}
const needsSqlite = { skip: sqlite ? false : "node:sqlite needs Node 22.13 or later" };

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-browsers-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  delete process.env.CHROME_BOOKMARKS_PATH;
  delete process.env.CHROME_PROFILE;
  delete process.env.MNEMOS_BOOKMARKS_BROWSER;
});

function write(file, data) {
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const chromiumFile = (children) =>
  JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "", children } } });

const titles = (items) => items.map((m) => m.title);

// ---------------------------------------------------------------------------
// Choosing a browser, and the Chromium family
// ---------------------------------------------------------------------------

test("MNEMOS_BOOKMARKS_BROWSER: unset or empty means Chrome; case and spaces ignored", () => {
  assert.equal(browsers.selectedBrowser({}), "chrome");
  assert.equal(browsers.selectedBrowser({ MNEMOS_BOOKMARKS_BROWSER: "" }), "chrome");
  assert.equal(browsers.selectedBrowser({ MNEMOS_BOOKMARKS_BROWSER: " Firefox " }), "firefox");
});

test("MNEMOS_BOOKMARKS_BROWSER: an unknown browser is an error naming the choices", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "netscape";
  assert.throws(
    () => lib.listFolders(),
    /MNEMOS_BOOKMARKS_BROWSER is "netscape"; use one of: chrome, chromium, edge, brave, vivaldi, firefox, safari\./,
  );
});

test("each Chromium browser's user-data directory, per platform", () => {
  const env = {
    LOCALAPPDATA: path.join(home, "Local"),
    XDG_CONFIG_HOME: path.join(home, "xdg"),
  };
  const mac = (...p) => path.join(home, "Library", "Application Support", ...p);
  const expected = {
    chrome: [mac("Google", "Chrome"), ["Google", "Chrome", "User Data"], ["google-chrome"]],
    chromium: [mac("Chromium"), ["Chromium", "User Data"], ["chromium"]],
    edge: [mac("Microsoft Edge"), ["Microsoft", "Edge", "User Data"], ["microsoft-edge"]],
    brave: [
      mac("BraveSoftware", "Brave-Browser"),
      ["BraveSoftware", "Brave-Browser", "User Data"],
      ["BraveSoftware", "Brave-Browser"],
    ],
    vivaldi: [mac("Vivaldi"), ["Vivaldi", "User Data"], ["vivaldi"]],
  };
  for (const [browser, [darwin, win32, linux]] of Object.entries(expected)) {
    assert.equal(browsers.chromiumBase(browser, "darwin", env), darwin, browser);
    assert.equal(browsers.chromiumBase(browser, "win32", env), path.join(env.LOCALAPPDATA, ...win32), browser);
    assert.equal(browsers.chromiumBase(browser, "linux", env), path.join(env.XDG_CONFIG_HOME, ...linux), browser);
  }
  assert.equal(lib.chromeBase("darwin", env), browsers.chromiumBase("chrome", "darwin", env));
});

test("Edge, Brave, Vivaldi and Chromium read their own profile's Bookmarks file", () => {
  for (const browser of ["edge", "brave", "vivaldi", "chromium"]) {
    process.env.MNEMOS_BOOKMARKS_BROWSER = browser;
    process.env.CHROME_PROFILE = "Profile 2";
    const file = path.join(browsers.chromiumBase(browser), "Profile 2", "Bookmarks");
    assert.equal(lib.bookmarksPath(), file);
    write(file, chromiumFile([{ type: "url", name: `${browser} page`, url: "https://example.com/" }]));
    assert.deepEqual(titles(lib.recentBookmarks().bookmarks), [`${browser} page`]);
  }
});

test("a missing profile names the browser's profiles and the other browsers with bookmarks", () => {
  write(
    path.join(browsers.chromiumBase("edge"), "Default", "Bookmarks"),
    chromiumFile([{ type: "url", name: "x", url: "https://example.com/" }]),
  );
  write(
    path.join(browsers.chromiumBase("brave"), "Profile 1", "Bookmarks"),
    chromiumFile([]),
  );
  process.env.MNEMOS_BOOKMARKS_BROWSER = "brave";
  assert.throws(
    () => lib.listFolders(),
    (err) => {
      assert.match(err.message, /Brave profiles that have bookmarks: Profile 1\./);
      assert.match(
        err.message,
        /Other browsers with bookmarks here: Edge \(set MNEMOS_BOOKMARKS_BROWSER to edge\)\./,
      );
      return true;
    },
  );
});

test("Vivaldi: a description in meta_info is returned and searched; its Trash is skipped", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "vivaldi";
  write(
    lib.bookmarksPath(),
    chromiumFile([
      {
        type: "url",
        name: "Tidepools",
        url: "https://example.org/tidepools",
        meta_info: { Description: "  Coastal ecology primer  ", Nickname: "tp" },
      },
      { type: "url", name: "Plain", url: "https://example.org/plain", meta_info: { Description: " " } },
      {
        type: "folder",
        name: "Trash",
        meta_info: { Trash: "true" },
        children: [{ type: "url", name: "Deleted coastal page", url: "https://example.org/gone" }],
      },
    ]),
  );
  const hits = lib.searchBookmarks("coastal");
  assert.equal(hits.total_matches, 1);
  assert.equal(hits.matches[0].title, "Tidepools");
  assert.equal(hits.matches[0].description, "Coastal ecology primer");
  const plain = lib.searchBookmarks("plain").matches[0];
  assert.ok(!("description" in plain), "a blank description is left out");
  assert.deepEqual(
    lib.listFolders().folders.map((f) => f.folder),
    ["Bookmarks Bar"],
  );
});

test("a Chrome bookmark has no description field", () => {
  process.env.CHROME_BOOKMARKS_PATH = path.join(ROOT, "test", "fixtures", "bookmarks.json");
  for (const item of lib.recentBookmarks().bookmarks) assert.ok(!("description" in item), item.title);
});

test("a long description is clipped", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "vivaldi";
  write(
    lib.bookmarksPath(),
    chromiumFile([{ type: "url", name: "Long", url: "https://e.org/", meta_info: { Description: "d".repeat(5000) } }]),
  );
  const [item] = lib.recentBookmarks().bookmarks;
  assert.equal(item.description.length, 1001);
  assert.ok(item.description.endsWith("…"));
});

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

/** 2024-05-01T12:00:00Z in microseconds since the Unix epoch, as Firefox stores dateAdded. */
const MAY_FIRST_US = Date.UTC(2024, 4, 1, 12) * 1000;

/**
 * A places.sqlite with the parts of Firefox's schema mnemos reads, and a tree:
 * root › menu, toolbar, tags, unfiled, mobile (Firefox's built-in folders),
 * bookmarks out of id order, a separator, a saved query, a tag entry, and
 * descriptions both typed by the user (an annotation) and from the page.
 * Returns the open database; the caller closes it.
 */
function makePlaces(file, { wal = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
      description TEXT);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
      parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER,
      lastModified INTEGER, guid TEXT);
    CREATE TABLE moz_anno_attributes (id INTEGER PRIMARY KEY, name VARCHAR(32) UNIQUE NOT NULL);
    CREATE TABLE moz_items_annos (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL,
      anno_attribute_id INTEGER, content LONGVARCHAR);
  `);
  const place = db.prepare("INSERT INTO moz_places (id, url, title, description) VALUES (?, ?, ?, ?)");
  place.run(1, "https://www.mozilla.org/", "Mozilla page title", "Internet for people, not profit");
  place.run(2, "https://example.com/untitled", "Page title fallback", null);
  place.run(3, "place:sort=8&maxResults=10", null, null);
  place.run(4, "https://notes.example/", "Notes page", "the page's own blurb");
  place.run(5, "https://tagged.example/", "Tagged", null);
  const mark = db.prepare(
    "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  mark.run(1, 2, null, 0, 0, "", 0, "root________");
  mark.run(2, 2, null, 1, 0, "menu", 0, "menu________");
  mark.run(3, 2, null, 1, 1, "toolbar", 0, "toolbar_____");
  mark.run(4, 2, null, 1, 2, "tags", 0, "tags________");
  mark.run(5, 2, null, 1, 3, "unfiled", 0, "unfiled_____");
  mark.run(6, 2, null, 1, 4, "mobile", 0, "mobile______");
  // Toolbar, by position: Research folder, separator, Mozilla, saved query.
  mark.run(10, 1, 1, 3, 2, "Mozilla", MAY_FIRST_US, "bm-mozilla");
  mark.run(11, 3, null, 3, 1, null, 0, "bm-separator");
  mark.run(12, 2, null, 3, 0, "Research", 0, "bm-research");
  mark.run(13, 1, 4, 12, 0, "Notes", MAY_FIRST_US, "bm-notes");
  mark.run(14, 1, 3, 3, 3, "Most Visited", 0, "bm-query");
  mark.run(15, 2, null, 4, 0, "sometag", 0, "bm-tag");
  mark.run(16, 1, 5, 15, 0, null, 0, "bm-tagged");
  mark.run(17, 1, 2, 5, 0, null, 0, "bm-untitled");
  db.exec(`
    INSERT INTO moz_anno_attributes (id, name) VALUES (1, 'bookmarkProperties/description');
    INSERT INTO moz_items_annos (item_id, anno_attribute_id, content)
      VALUES (13, 1, 'my own note on tidepools');
  `);
  return db;
}

/** A Firefox directory with profiles.ini listing the given profiles. */
function makeFirefox(ini) {
  const base = browsers.firefoxBase();
  write(path.join(base, "profiles.ini"), ini);
  return base;
}

const PROFILES_INI = [
  "[Install4F96D1932A9F858E]",
  "Default=Profiles/bbbb.default-release",
  "Locked=1",
  "",
  "[Profile1]",
  "Name=default",
  "IsRelative=1",
  "Path=Profiles/aaaa.default",
  "Default=1",
  "",
  "[Profile0]",
  "Name=default-release",
  "IsRelative=1",
  "Path=Profiles/bbbb.default-release",
  "",
  "[General]",
  "StartWithLastProfile=1",
  "Version=2",
  "",
].join("\r\n");

test("Firefox: the profile directory per platform", () => {
  const env = { APPDATA: path.join(home, "Roaming"), XDG_CONFIG_HOME: path.join(home, "xdg") };
  assert.equal(
    browsers.firefoxBase("darwin", env),
    path.join(home, "Library", "Application Support", "Firefox"),
  );
  assert.equal(browsers.firefoxBase("win32", env), path.join(env.APPDATA, "Mozilla", "Firefox"));
  assert.equal(browsers.firefoxBase("linux", env), path.join(home, ".mozilla", "firefox"));
  // On Linux the first directory holding a profiles.ini wins.
  const snap = path.join(home, "snap", "firefox", "common", ".mozilla", "firefox");
  write(path.join(snap, "profiles.ini"), "[Profile0]\nPath=x\n");
  assert.equal(browsers.firefoxBase("linux", env), snap);
  const xdg = path.join(env.XDG_CONFIG_HOME, "mozilla", "firefox");
  write(path.join(xdg, "profiles.ini"), "[Profile0]\nPath=x\n");
  assert.equal(browsers.firefoxBase("linux", env), xdg);
});

test("Firefox: profiles.ini's Install default wins over Default=1, which wins over file order", () => {
  const base = makeFirefox(PROFILES_INI);
  assert.deepEqual(browsers.firefoxProfiles(base), [
    { name: "default", dir: path.join(base, "Profiles/aaaa.default"), isDefault: false },
    { name: "default-release", dir: path.join(base, "Profiles/bbbb.default-release"), isDefault: true },
  ]);
  makeFirefox("[Profile0]\nName=a\nIsRelative=1\nPath=A\n\n[Profile1]\nName=b\nIsRelative=1\nPath=B\nDefault=1\n");
  assert.deepEqual(
    browsers.firefoxProfiles(base).map((p) => [p.name, p.isDefault]),
    [["a", false], ["b", true]],
  );
  const absolute = path.join(home, "elsewhere", "profile");
  makeFirefox(`[Profile0]\nName=away\nIsRelative=0\nPath=${absolute}\n`);
  assert.equal(browsers.firefoxProfiles(base)[0].dir, absolute);
});

test("Firefox: CHROME_PROFILE picks a profile by name or directory; unknown names list the others", () => {
  const base = makeFirefox(PROFILES_INI);
  process.env.MNEMOS_BOOKMARKS_BROWSER = "firefox";
  const release = path.join(base, "Profiles/bbbb.default-release", "places.sqlite");
  const plain = path.join(base, "Profiles/aaaa.default", "places.sqlite");
  assert.equal(lib.bookmarksPath(), release);
  process.env.CHROME_PROFILE = "default";
  assert.equal(lib.bookmarksPath(), plain);
  process.env.CHROME_PROFILE = "bbbb.default-release";
  assert.equal(lib.bookmarksPath(), release);
  process.env.CHROME_PROFILE = "Default-Release";
  assert.equal(lib.bookmarksPath(), release);
  write(plain, "");
  process.env.CHROME_PROFILE = "work";
  assert.throws(
    () => lib.bookmarksPath(),
    /No Firefox profile named "work".*Firefox profiles that have bookmarks: default\./s,
  );
});

test("Firefox: no profiles.ini is a friendly error", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "firefox";
  assert.throws(() => lib.listFolders(), /No Firefox profiles found: no profiles\.ini in /);
});

test("Firefox: a profile without places.sqlite lists the profiles that have one", () => {
  const base = makeFirefox(PROFILES_INI);
  write(path.join(base, "Profiles/aaaa.default", "places.sqlite"), "");
  process.env.MNEMOS_BOOKMARKS_BROWSER = "firefox";
  assert.throws(
    () => lib.listFolders(),
    /No bookmarks file at .*bbbb\.default-release.*Firefox profiles that have bookmarks: default\./s,
  );
});

test("Firefox: roots, folders and order come from places.sqlite", needsSqlite, () => {
  const base = makeFirefox(PROFILES_INI);
  process.env.MNEMOS_BOOKMARKS_BROWSER = "firefox";
  makePlaces(lib.bookmarksPath()).close();
  assert.ok(lib.bookmarksPath().startsWith(base));
  assert.deepEqual(Object.keys(lib.loadRoots()), [
    "Bookmarks Menu",
    "Bookmarks Toolbar",
    "Other Bookmarks",
    "Mobile Bookmarks",
  ]);
  const { folders, total_bookmarks } = lib.listFolders();
  // The tags root, the separator and the saved query are not bookmarks.
  assert.equal(total_bookmarks, 3);
  assert.deepEqual(
    folders.map((f) => [f.folder, f.bookmarks]),
    [
      ["Bookmarks Menu", 0],
      ["Bookmarks Toolbar", 1],
      ["Bookmarks Toolbar › Research", 1],
      ["Mobile Bookmarks", 0],
      ["Other Bookmarks", 1],
    ],
  );
  // Document order follows `position`, not row ids.
  assert.deepEqual(titles(lib.listFolderContents("Bookmarks Toolbar").bookmarks), ["Notes", "Mozilla"]);
});

test("Firefox: titles, dates and descriptions", needsSqlite, () => {
  makeFirefox(PROFILES_INI);
  process.env.MNEMOS_BOOKMARKS_BROWSER = "firefox";
  makePlaces(lib.bookmarksPath()).close();
  const all = Object.fromEntries(lib.recentBookmarks().bookmarks.map((b) => [b.url, b]));
  assert.deepEqual(all["https://www.mozilla.org/"], {
    title: "Mozilla",
    url: "https://www.mozilla.org/",
    folder: "Bookmarks Toolbar",
    added: "2024-05-01",
    description: "Internet for people, not profit",
  });
  // The description the user typed beats the page's own.
  assert.equal(all["https://notes.example/"].description, "my own note on tidepools");
  // A bookmark with no title of its own shows the page's title.
  assert.equal(all["https://example.com/untitled"].title, "Page title fallback");
  assert.equal(all["https://example.com/untitled"].added, null);
  assert.ok(!("description" in all["https://example.com/untitled"]));
  // Search reaches the description.
  assert.deepEqual(titles(lib.searchBookmarks("tidepools").matches), ["Notes"]);
  assert.equal(lib.searchBookmarks("tagged").total_matches, 0);
  assert.equal(lib.searchBookmarks("visited").total_matches, 0);
});

test("Firefox: writes still in places.sqlite-wal are read, and the original is not touched", needsSqlite, () => {
  makeFirefox(PROFILES_INI);
  process.env.MNEMOS_BOOKMARKS_BROWSER = "firefox";
  const file = lib.bookmarksPath();
  // Firefox keeps the database open; with checkpoints off, everything written
  // so far sits in the WAL, and the main file holds no bookmarks yet.
  const db = makePlaces(file, { wal: true });
  try {
    assert.ok(fs.statSync(`${file}-wal`).size > 0, "the writes are in the WAL");
    const before = fs.readdirSync(path.dirname(file)).sort();
    const stat = fs.statSync(file);
    assert.equal(lib.listFolders().total_bookmarks, 3);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), before);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
    // A bookmark added while mnemos runs shows up on the next call.
    db.prepare(
      "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (40, 1, 1, 6, 0, 'Phone bookmark', 0, 'bm-phone')",
    ).run();
    assert.equal(lib.listFolders().total_bookmarks, 4);
    assert.deepEqual(titles(lib.listFolderContents("Mobile Bookmarks").bookmarks), ["Phone bookmark"]);
  } finally {
    db.close();
  }
});

test("Firefox: an SQLite file that is not places.sqlite is a friendly error", needsSqlite, () => {
  const file = path.join(home, "other.sqlite");
  const db = new sqlite.DatabaseSync(file);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
  db.close();
  process.env.CHROME_BOOKMARKS_PATH = file;
  assert.throws(() => lib.listFolders(), /is not a Firefox places\.sqlite database/);
});

test("CHROME_BOOKMARKS_PATH may point at a places.sqlite", needsSqlite, () => {
  const file = path.join(home, "copy", "places.sqlite");
  makePlaces(file).close();
  process.env.CHROME_BOOKMARKS_PATH = file;
  assert.equal(lib.listFolders().total_bookmarks, 3);
});

// ---------------------------------------------------------------------------
// Safari
// ---------------------------------------------------------------------------

const safariFile = () => path.join(home, "Library", "Safari", "Bookmarks.plist");

test("Safari: roots under Safari's names, History skipped, loose bookmarks kept", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "safari";
  assert.equal(lib.bookmarksPath(), safariFile());
  write(safariFile(), fs.readFileSync(SAFARI_FIXTURE));
  assert.deepEqual(Object.keys(lib.loadRoots()), [
    "Favorites",
    "Bookmarks Menu",
    "Recipes",
    "Reading List",
    "Bookmarks",
  ]);
  const { folders, total_bookmarks } = lib.listFolders();
  assert.equal(total_bookmarks, 7);
  assert.deepEqual(
    folders.map((f) => f.folder),
    ["Bookmarks", "Bookmarks Menu", "Favorites", "Favorites › Ελληνικά", "Reading List", "Recipes"],
  );
  assert.deepEqual(titles(lib.listFolderContents("Ελληνικά").bookmarks), ["Βικιπαίδεια"]);
});

test("Safari: Reading List items carry their date and preview text", () => {
  process.env.CHROME_BOOKMARKS_PATH = SAFARI_FIXTURE;
  const { bookmarks } = lib.recentBookmarks(1);
  assert.deepEqual(bookmarks[0], {
    title: "Tidepools",
    url: "https://example.org/tidepools",
    folder: "Reading List",
    added: "2024-05-01",
    description: "Why tidepools matter for coastal ecology.",
  });
  assert.deepEqual(titles(lib.searchBookmarks("coastal").matches), ["Tidepools"]);
  const undated = lib.searchBookmarks("undated").matches[0];
  assert.equal(undated.added, null);
  assert.ok(!("description" in undated));
});

test("Safari: a missing file, and one macOS will not let mnemos read", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "safari";
  const expected =
    process.platform === "darwin" ? /No bookmarks file at .*Bookmarks\.plist\./ : /only on macOS/;
  assert.throws(() => lib.listFolders(), expected);
  write(safariFile(), fs.readFileSync(SAFARI_FIXTURE));
  const openSync = fs.openSync;
  fs.openSync = () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  };
  try {
    assert.throws(() => lib.listFolders(), /Full Disk Access/);
  } finally {
    fs.openSync = openSync;
  }
});

test("Safari: XML and corrupt plists are friendly errors", () => {
  process.env.CHROME_BOOKMARKS_PATH = path.join(home, "Bookmarks.plist");
  write(process.env.CHROME_BOOKMARKS_PATH, '<?xml version="1.0" encoding="UTF-8"?>\n<plist/>');
  assert.throws(() => lib.listFolders(), /not a binary property list.*plutil -convert binary1/s);
  const data = fs.readFileSync(SAFARI_FIXTURE);
  write(process.env.CHROME_BOOKMARKS_PATH, data.subarray(0, data.length - 8));
  assert.throws(() => lib.listFolders(), /is not a valid binary property list/);
});

test("Safari: a binary plist that is not Safari's bookmarks is a friendly error", () => {
  // A one-string plist: header, object, offset table, trailer.
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(1n, 8);
  trailer.writeBigUInt64BE(10n, 24);
  process.env.CHROME_BOOKMARKS_PATH = path.join(home, "Other.plist");
  write(
    process.env.CHROME_BOOKMARKS_PATH,
    Buffer.concat([Buffer.from("bplist00"), Buffer.from([0x51, 0x78]), Buffer.from([8]), trailer]),
  );
  assert.throws(() => lib.listFolders(), /is not a Safari Bookmarks\.plist/);
});
