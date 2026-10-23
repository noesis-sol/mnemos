// A Firefox places.sqlite locked by a running Firefox: another connection
// holds the file under PRAGMA locking_mode=EXCLUSIVE with a write transaction
// open, as Firefox does. src/browsers.ts reads a copy of the database and its
// WAL, so the lock does not stop it: --browser firefox reads the bookmarks
// committed so far, --browser all reads the locked profile beside the other
// sources, and once the lock is released the next call reads what was
// written under it. Each test points every platform's home variable at a
// fresh temp dir, so the browsers' default paths land inside it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";

let sqlite;
try {
  sqlite = createRequire(import.meta.url)("node:sqlite");
} catch {
  // Node before 22.13: the places.sqlite tests skip.
}
const needsSqlite = { skip: sqlite ? false : "node:sqlite needs Node 22.13 or later" };

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-locked-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  delete process.env.MNEMOS_BOOKMARKS_PATH;
  delete process.env.CHROME_BOOKMARKS_PATH;
  delete process.env.MNEMOS_PROFILE;
  delete process.env.CHROME_PROFILE;
  delete process.env.MNEMOS_BOOKMARKS_BROWSER;
  browsers.setStartupOptions({});
});

afterEach(() => {
  browsers.setStartupOptions({});
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

function write(file, data) {
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const PROFILES_INI = "[Profile0]\nName=default-release\nIsRelative=1\nPath=profile.default\nDefault=1\n";

/** Firefox's default profile with a places.sqlite in WAL mode, as Firefox keeps it, holding one bookmark. */
function makePlaces() {
  const base = browsers.firefoxBase();
  write(path.join(base, "profiles.ini"), PROFILES_INI);
  const file = path.join(base, "profile.default", "places.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const places = new sqlite.DatabaseSync(file);
  try {
    places.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        description TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
        parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER,
        lastModified INTEGER, guid TEXT);
    `);
    const mark = places.prepare(
      "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    mark.run(1, 2, null, 0, 0, "", 0, "root________");
    mark.run(2, 2, null, 1, 0, "toolbar", 0, "toolbar_____");
    addBookmark(places, 10, "Mozilla", "https://mozilla.example/");
  } finally {
    places.close();
  }
  return file;
}

function addBookmark(db, id, title, url) {
  db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)").run(id, url, title);
  db.prepare(
    "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, 1, ?, 2, ?, ?, ?, ?)",
  ).run(id, id, id, title, 1_700_000_000_000_000, `bm-${id}`);
}

/**
 * Lock `file` as a running Firefox does: a connection in exclusive locking
 * mode with a write transaction open, holding a bookmark not yet committed.
 * Returns the connection; commit and close it to release the lock.
 */
function lockPlaces(file) {
  const firefox = new sqlite.DatabaseSync(file);
  firefox.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  addBookmark(firefox, 20, "Uncommitted tab", "https://pending.example/");
  // The lock is real: another connection cannot read the file.
  const other = new sqlite.DatabaseSync(file);
  try {
    assert.throws(() => other.prepare("SELECT count(*) FROM moz_bookmarks").get(), /locked|busy/i);
  } finally {
    other.close();
  }
  return firefox;
}

/** A Chrome Default profile with one bookmark; returns its Bookmarks file. */
function makeChrome() {
  const file = path.join(browsers.chromiumBase("chrome"), "Default", "Bookmarks");
  write(
    file,
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "",
          children: [{ type: "url", name: "Recipes", url: "https://food.example/", date_added: "13350000000000000" }],
        },
      },
    }),
  );
  return file;
}

const titles = (result) => result.matches.map((m) => m.title).sort();

test("--browser firefox: a places.sqlite locked by a running Firefox reads its committed bookmarks", needsSqlite, () => {
  const file = makePlaces();
  const firefox = lockPlaces(file);
  try {
    browsers.setStartupOptions(browsers.parseStartupArgs(["--browser", "firefox"]));
    const result = lib.searchBookmarks("example");
    // The bookmark written under the lock is not committed, so it is not read.
    assert.deepEqual(titles(result), ["Mozilla"]);
    assert.equal("warnings" in result, false);
  } finally {
    firefox.close();
  }
});

test("--browser all: the locked Firefox profile does not stop the other sources answering", needsSqlite, () => {
  const chrome = makeChrome();
  const file = makePlaces();
  const firefox = lockPlaces(file);
  try {
    browsers.setStartupOptions(browsers.parseStartupArgs(["--browser", "all"]));
    const result = lib.searchBookmarks("example");
    assert.deepEqual(result.sources, [
      { browser: "chrome", profile: "Default", bookmarks: chrome },
      { browser: "firefox", profile: "default-release (profile.default)", bookmarks: file },
    ]);
    assert.deepEqual(titles(result), ["Mozilla", "Recipes"]);
    // The lock is no error: the Firefox profile is read, so there is nothing to warn of.
    assert.equal("warnings" in result, false);
  } finally {
    firefox.close();
  }
});

test("after the lock is released, the next call reads what was written under it", needsSqlite, () => {
  const file = makePlaces();
  const firefox = lockPlaces(file);
  browsers.setStartupOptions(browsers.parseStartupArgs(["--browser", "firefox"]));
  try {
    assert.deepEqual(titles(lib.searchBookmarks("example")), ["Mozilla"]);
    firefox.exec("COMMIT");
  } finally {
    firefox.close();
  }
  // Firefox has quit: the file is unlocked, and holds the bookmark committed before it did.
  const reader = new sqlite.DatabaseSync(file);
  try {
    assert.equal(reader.prepare("SELECT count(*) AS n FROM moz_bookmarks").get().n, 4);
  } finally {
    reader.close();
  }
  assert.deepEqual(titles(lib.searchBookmarks("example")), ["Mozilla", "Uncommitted tab"]);
});
