// Firefox's forks — LibreWolf, Waterfox, Zen, Floorp and Tor Browser — as
// browser ids: each one's profiles directory per platform, a places.sqlite
// read through each id with the Firefox reader, errors and discovery naming
// the fork, and the system default browser mapping to it. Like
// browsers.test.js, each test points every platform's home variable at a
// fresh temp dir, so the browsers' default paths land inside it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";
import * as db from "../dist/default-browser.js";

let sqlite;
try {
  sqlite = createRequire(import.meta.url)("node:sqlite");
} catch {
  // Node before 22.13: the places.sqlite tests skip.
}
const needsSqlite = { skip: sqlite ? false : "node:sqlite needs Node 22.13 or later" };

const FORKS = ["librewolf", "waterfox", "zen", "floorp", "tor-browser"];

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-forks-"));
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
  fs.rmSync(home, { recursive: true, force: true });
});

function write(file, data) {
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const PROFILES_INI = "[Profile0]\nName=default\nIsRelative=1\nPath=profile.default\nDefault=1\n";

/** A places.sqlite holding one bookmark, titled after `label`, on the toolbar. */
function makePlaces(file, label) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const places = new sqlite.DatabaseSync(file);
  try {
    places.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        description TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
        parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER,
        lastModified INTEGER, guid TEXT);
    `);
    places.prepare("INSERT INTO moz_places (id, url, title) VALUES (1, ?, ?)").run(`https://${label}.example/`, label);
    const mark = places.prepare(
      "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    mark.run(1, 2, null, 0, 0, "", 0, "root________");
    mark.run(2, 2, null, 1, 0, "toolbar", 0, "toolbar_____");
    mark.run(3, 1, 1, 2, 0, label, Date.UTC(2024, 4, 1) * 1000, `bm-${label}`);
  } finally {
    places.close();
  }
}

test("the forks are browser ids read with the Firefox reader", () => {
  for (const fork of FORKS) {
    assert.ok(browsers.BROWSERS.includes(fork), fork);
    assert.ok(browsers.isFirefox(fork), fork);
    assert.ok(!browsers.isChromium(fork), fork);
    assert.equal(browsers.selectedBrowser({}, { browser: fork }), fork);
    assert.deepEqual(browsers.parseStartupArgs(["--browser", fork]), { browser: fork });
  }
  assert.equal(browsers.selectedBrowser({ MNEMOS_BOOKMARKS_BROWSER: " LibreWolf " }), "librewolf");
  assert.equal(browsers.BROWSER_NAMES["tor-browser"], "Tor Browser");
  assert.ok(browsers.isFirefox("firefox"));
  assert.ok(!browsers.isFirefox("chrome") && !browsers.isFirefox("safari"));
});

test("each fork's profiles directory, per platform", () => {
  const env = { APPDATA: path.join(home, "Roaming"), XDG_CONFIG_HOME: path.join(home, "xdg") };
  const mac = (...p) => path.join(home, "Library", "Application Support", ...p);
  const tor = ["Browser", "TorBrowser", "Data", "Browser"];
  const expected = {
    librewolf: [mac("librewolf"), path.join(env.APPDATA, "librewolf"), path.join(home, ".librewolf")],
    waterfox: [mac("Waterfox"), path.join(env.APPDATA, "Waterfox"), path.join(home, ".waterfox")],
    zen: [mac("zen"), path.join(env.APPDATA, "zen"), path.join(home, ".zen")],
    floorp: [mac("Floorp"), path.join(env.APPDATA, "Floorp"), path.join(home, ".floorp")],
    "tor-browser": [
      mac("TorBrowser-Data", "Browser"),
      path.join(home, "Desktop", "Tor Browser", ...tor),
      path.join(home, "tor-browser", ...tor),
    ],
  };
  for (const [fork, [darwin, win32, linux]] of Object.entries(expected)) {
    assert.equal(browsers.firefoxBase(fork, "darwin", env), darwin, `${fork} on macOS`);
    assert.equal(browsers.firefoxBase(fork, "win32", env), win32, `${fork} on Windows`);
    assert.equal(browsers.firefoxBase(fork, "linux", env), linux, `${fork} on Linux`);
    assert.equal(browsers.firefoxBase(fork, "freebsd", env), linux, `${fork} on other unixes`);
  }
  // Without APPDATA, Windows falls back to the Roaming directory in the home.
  assert.equal(
    browsers.firefoxBase("zen", "win32", {}),
    path.join(home, "AppData", "Roaming", "zen"),
  );
});

test("Linux: a fork's Flatpak directory wins when only it has a profiles.ini", () => {
  const flatpaks = {
    librewolf: path.join(home, ".var", "app", "io.gitlab.librewolf-community", ".librewolf"),
    waterfox: path.join(home, ".var", "app", "net.waterfox.waterfox", ".waterfox"),
    zen: path.join(home, ".var", "app", "app.zen_browser.zen", ".zen"),
    floorp: path.join(home, ".var", "app", "one.ablaze.floorp", ".floorp"),
  };
  for (const [fork, dir] of Object.entries(flatpaks)) {
    write(path.join(dir, "profiles.ini"), PROFILES_INI);
    assert.equal(browsers.firefoxBase(fork, "linux", {}), dir, fork);
  }
  // The native package's directory, once it has a profiles.ini, comes first.
  write(path.join(home, ".zen", "profiles.ini"), PROFILES_INI);
  assert.equal(browsers.firefoxBase("zen", "linux", {}), path.join(home, ".zen"));
});

test("Tor Browser: its install locations are tried in order", () => {
  const data = ["Browser", "TorBrowser", "Data", "Browser"];
  const launcher = ["torbrowser", "tbb", "x86_64", "tor-browser", ...data];
  const linux = [
    path.join(home, ".var", "app", "org.torproject.torbrowser-launcher", "data", ...launcher),
    path.join(home, ".local", "share", ...launcher),
    path.join(home, "tor-browser_en-US", ...data),
    path.join(home, "tor-browser", ...data),
  ];
  // Each one found wins over those after it.
  for (const dir of linux) {
    write(path.join(dir, "profiles.ini"), PROFILES_INI);
    assert.equal(browsers.firefoxBase("tor-browser", "linux", {}), dir);
  }
  const oneDrive = path.join(home, "OneDrive", "Desktop", "Tor Browser", ...data);
  write(path.join(oneDrive, "profiles.ini"), PROFILES_INI);
  assert.equal(browsers.firefoxBase("tor-browser", "win32", {}), oneDrive);
  const desktop = path.join(home, "Desktop", "Tor Browser", ...data);
  write(path.join(desktop, "profiles.ini"), PROFILES_INI);
  assert.equal(browsers.firefoxBase("tor-browser", "win32", {}), desktop);
});

test("a generated places.sqlite reads through each fork's id", needsSqlite, () => {
  for (const fork of FORKS) {
    const base = browsers.firefoxBase(fork);
    write(path.join(base, "profiles.ini"), PROFILES_INI);
    makePlaces(path.join(base, "profile.default", "places.sqlite"), fork);
  }
  for (const fork of FORKS) {
    process.env.MNEMOS_BOOKMARKS_BROWSER = fork;
    const base = browsers.firefoxBase(fork);
    assert.equal(lib.bookmarksPath(), path.join(base, "profile.default", "places.sqlite"), fork);
    assert.deepEqual(Object.keys(lib.loadRoots()), ["Bookmarks Toolbar"], fork);
    const [bookmark] = lib.recentBookmarks().bookmarks;
    assert.deepEqual(
      bookmark,
      { title: fork, url: `https://${fork}.example/`, folder: "Bookmarks Toolbar", added: "2024-05-01" },
      fork,
    );
    assert.deepEqual(lib.searchBookmarks(fork).matches.map((m) => m.title), [fork]);
  }
  // Every fork, and nothing else, is found with bookmarks.
  assert.deepEqual(browsers.browsersWithBookmarks(undefined), FORKS);
  assert.deepEqual(browsers.browsersWithBookmarks("zen"), FORKS.filter((f) => f !== "zen"));
});

test("errors name the fork, its profiles and the other browsers", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "librewolf";
  assert.throws(
    () => lib.listFolders(),
    /No LibreWolf profiles found: no profiles\.ini in .*librewolf.*a LibreWolf places\.sqlite file\./s,
  );
  const base = browsers.firefoxBase("librewolf");
  write(
    path.join(base, "profiles.ini"),
    PROFILES_INI + "\n[Profile1]\nName=work\nIsRelative=1\nPath=profile.work\n",
  );
  write(path.join(base, "profile.work", "places.sqlite"), "");
  const floorp = browsers.firefoxBase("floorp");
  write(path.join(floorp, "profiles.ini"), PROFILES_INI);
  write(path.join(floorp, "profile.default", "places.sqlite"), "");
  assert.throws(
    () => lib.listFolders(),
    /No bookmarks file at .*profile\.default.*LibreWolf profiles that have bookmarks: work \(profile\.work\)\. .*Other browsers with bookmarks here: Floorp \(choose one with --browser or MNEMOS_BOOKMARKS_BROWSER: floorp\)\./s,
  );
  process.env.MNEMOS_PROFILE = "play";
  assert.throws(
    () => lib.bookmarksPath(),
    /No LibreWolf profile named "play" in .*LibreWolf profiles that have bookmarks: work \(profile\.work\)\./s,
  );
  process.env.MNEMOS_PROFILE = "Work";
  assert.equal(lib.bookmarksPath(), path.join(base, "profile.work", "places.sqlite"));
});

test("the system default browser maps to the fork", () => {
  const cases = [
    ["darwin", "io.gitlab.librewolf-community", "librewolf"],
    ["darwin", "net.waterfox.waterfox", "waterfox"],
    ["darwin", "app.zen-browser.zen", "zen"],
    ["darwin", "one.ablaze.floorp", "floorp"],
    ["darwin", "org.torproject.torbrowser", "tor-browser"],
    ["win32", "WaterfoxURL-E7CF176E110C211B", "waterfox"],
    ["linux", "librewolf.desktop", "librewolf"],
    ["linux", "io.gitlab.librewolf-community.desktop", "librewolf"],
    ["linux", "waterfox.desktop", "waterfox"],
    ["linux", "net.waterfox.waterfox.desktop", "waterfox"],
    ["linux", "app.zen_browser.zen.desktop", "zen"],
    ["linux", "one.ablaze.floorp.desktop", "floorp"],
    ["linux", "torbrowser.desktop", "tor-browser"],
    ["linux", "org.torproject.torbrowser-launcher.desktop", "tor-browser"],
  ];
  for (const [platform, id, browser] of cases) {
    assert.deepEqual(db.identifyBrowser(platform, id), { browser }, `${platform} ${id}`);
  }
});
