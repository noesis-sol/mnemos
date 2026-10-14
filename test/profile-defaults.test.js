// Which profile mnemos reads when none is named, and profiles named by their
// display name: Chromium's Local State (profile.last_used, the names in
// profile.info_cache), Firefox's installs.ini and profiles.ini, and the
// missing-profile errors listing profiles as "Display Name (directory)". The
// Local State and INI files are fixtures in test/fixtures/profiles. Each test
// points every platform's home variable at a fresh temp dir, so the browsers'
// default paths land inside it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";

const FIXTURES = fileURLToPath(new URL("fixtures/profiles/", import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const SELECTION_VARS = [
  "CHROME_BOOKMARKS_PATH",
  "CHROME_PROFILE",
  "MNEMOS_BOOKMARKS_PATH",
  "MNEMOS_PROFILE",
  "MNEMOS_BOOKMARKS_BROWSER",
];

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-profile-defaults-"));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
  });
  for (const name of SELECTION_VARS) delete process.env[name];
  // Chrome unless a test chooses another: never this machine's default browser.
  process.env.MNEMOS_BOOKMARKS_BROWSER = "chrome";
});

afterEach(() => browsers.setStartupOptions({}));

function write(file, data) {
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const chromiumFile = (name) =>
  JSON.stringify({
    roots: { bookmark_bar: { type: "folder", name: "", children: [{ type: "url", name, url: "https://example.com/" }] } },
  });

/** A Chromium user-data directory with these profiles' Bookmarks files and, if given, a Local State fixture. */
function makeChromium(browser, profiles, localState) {
  const base = browsers.chromiumBase(browser);
  for (const profile of profiles) write(path.join(base, profile, "Bookmarks"), chromiumFile(`${profile} page`));
  if (localState !== undefined) write(path.join(base, "Local State"), localState);
  return base;
}

/** Chrome with Default, Profile 1 ("Work", last used) and Profile 2 ("Side Project"). */
const makeChrome = () =>
  makeChromium("chrome", ["Default", "Profile 1", "Profile 2"], fixture("chrome-local-state.json"));

const titles = () => lib.recentBookmarks().bookmarks.map((b) => b.title);

// ---------------------------------------------------------------------------
// Chromium: the default profile
// ---------------------------------------------------------------------------

test("Chromium: without a profile, Local State's last_used is read", () => {
  const base = makeChrome();
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 1", "Bookmarks"));
  assert.deepEqual(titles(), ["Profile 1 page"]);
});

test("Chromium: a Local State without last_used (Edge, Brave with one profile) means Default", () => {
  const base = makeChromium("edge", ["Default"], fixture("edge-local-state.json"));
  browsers.setStartupOptions({ browser: ["edge"] });
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
  assert.deepEqual(titles(), ["Default page"]);
});

test("Chromium: no Local State, or one that is not JSON, means Default", () => {
  const base = makeChromium("brave", ["Default", "Profile 1"]);
  browsers.setStartupOptions({ browser: ["brave"] });
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
  write(path.join(base, "Local State"), '{"profile": {"last_used": "Profile 1"'); // cut off mid-write
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
});

test("Chromium: a last_used whose directory is gone, or that is a path, means Default", () => {
  const base = makeChromium("chrome", ["Default"]);
  const state = (lastUsed) => JSON.stringify({ profile: { last_used: lastUsed } });
  write(path.join(base, "Local State"), state("Profile 7"));
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
  write(path.join(home, "elsewhere", "Bookmarks"), chromiumFile("outside"));
  for (const outside of [path.join("..", "..", "elsewhere"), path.join(home, "elsewhere"), "..", ""]) {
    write(path.join(base, "Local State"), state(outside));
    assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"), outside);
  }
});

test("Chromium: a named profile wins over last_used", () => {
  const base = makeChrome();
  process.env.MNEMOS_PROFILE = "Profile 2";
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 2", "Bookmarks"));
  browsers.setStartupOptions({ profile: "Default" });
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
});

test("Opera: without last_used, Default is the root-level Bookmarks file", () => {
  const base = browsers.chromiumBase("opera");
  write(path.join(base, "Bookmarks"), chromiumFile("opera root"));
  write(path.join(base, "Local State"), "{}");
  browsers.setStartupOptions({ browser: ["opera"] });
  assert.equal(lib.bookmarksPath(), path.join(base, "Bookmarks"));
});

// ---------------------------------------------------------------------------
// Chromium: display names
// ---------------------------------------------------------------------------

test("Chromium: --profile takes a display name from Local State, exactly or ignoring case", () => {
  const base = makeChrome();
  browsers.setStartupOptions({ profile: "Side Project" });
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 2", "Bookmarks"));
  assert.deepEqual(titles(), ["Profile 2 page"]);
  browsers.setStartupOptions({ profile: "side project" });
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 2", "Bookmarks"));
  process.env.MNEMOS_PROFILE = "Person 1";
  browsers.setStartupOptions({});
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
});

test("Chromium: a directory's name wins over another profile's display name", () => {
  // Edge names its Default profile "Profile 1"; a directory called Profile 1 is still Profile 1.
  const base = makeChromium("edge", ["Default"], fixture("edge-local-state.json"));
  browsers.setStartupOptions({ browser: ["edge"], profile: "Profile 1" });
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
  write(path.join(base, "Profile 1", "Bookmarks"), chromiumFile("Profile 1 page"));
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 1", "Bookmarks"));
});

test("Chromium: an unknown profile's error lists the profiles as 'Display Name (directory)'", () => {
  const base = makeChrome();
  write(path.join(base, "Profile 3", "Bookmarks"), chromiumFile("unnamed")); // not in info_cache
  browsers.setStartupOptions({ profile: "Personal" });
  assert.throws(
    () => lib.listFolders(),
    (err) => {
      assert.ok(err.message.includes(`No bookmarks file at ${path.join(base, "Personal", "Bookmarks")}.`), err.message);
      assert.ok(
        err.message.includes(
          "Chrome profiles that have bookmarks: Person 1 (Default), Work (Profile 1), Side Project (Profile 2), Profile 3.",
        ),
        err.message,
      );
      assert.match(err.message, /--profile or MNEMOS_PROFILE \(profile name or directory\)/);
      return true;
    },
  );
  assert.deepEqual(browsers.chromiumProfileLabels("chrome"), [
    "Person 1 (Default)",
    "Work (Profile 1)",
    "Side Project (Profile 2)",
    "Profile 3",
  ]);
});

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

/** A Firefox directory with the profiles.ini fixture and, if `installs`, the installs.ini fixture. */
function makeFirefox(installs) {
  const base = browsers.firefoxBase();
  write(path.join(base, "profiles.ini"), fixture("firefox-profiles.ini"));
  if (installs) write(path.join(base, "installs.ini"), fixture("firefox-installs.ini"));
  return base;
}

const places = (base, dir) => path.join(base, "Profiles", dir, "places.sqlite");

test("Firefox: without installs.ini the profile marked Default=1 is read", () => {
  const base = makeFirefox(false);
  browsers.setStartupOptions({ browser: ["firefox"] });
  assert.equal(lib.bookmarksPath(), places(base, "aaaa.default"));
});

test("Firefox: installs.ini's Default names the profile the install opens", () => {
  const base = makeFirefox(true);
  browsers.setStartupOptions({ browser: ["firefox"] });
  assert.equal(lib.bookmarksPath(), places(base, "cccc.work"));
  assert.deepEqual(
    browsers.firefoxProfiles(base).map((p) => [p.name, p.isDefault]),
    [["default", false], ["default-release", false], ["Work", true]],
  );
});

test("Firefox: an installs.ini Default naming no listed profile is passed over", () => {
  const base = makeFirefox(false);
  write(path.join(base, "installs.ini"), "[ABCDEF]\nDefault=Profiles/gone.default\n\n[123456]\nDefault=Profiles/bbbb.default-release\n");
  browsers.setStartupOptions({ browser: ["firefox"] });
  assert.equal(lib.bookmarksPath(), places(base, "bbbb.default-release"));
  write(path.join(base, "installs.ini"), "[ABCDEF]\nDefault=Profiles/gone.default\n");
  assert.equal(lib.bookmarksPath(), places(base, "aaaa.default"));
});

test("Firefox: --profile takes the Name= display name, exactly or ignoring case", () => {
  const base = makeFirefox(false);
  browsers.setStartupOptions({ browser: ["firefox"], profile: "Work" });
  assert.equal(lib.bookmarksPath(), places(base, "cccc.work"));
  browsers.setStartupOptions({ browser: ["firefox"], profile: "work" });
  assert.equal(lib.bookmarksPath(), places(base, "cccc.work"));
});

test("Firefox: an unknown profile's error lists the profiles as 'Name (directory)'", () => {
  const base = makeFirefox(true);
  write(places(base, "cccc.work"), "");
  write(places(base, "aaaa.default"), "");
  browsers.setStartupOptions({ browser: ["firefox"], profile: "Personal" });
  assert.throws(
    () => lib.bookmarksPath(),
    (err) => {
      assert.ok(
        err.message.includes("Firefox profiles that have bookmarks: Work (cccc.work), default (aaaa.default)."),
        err.message,
      );
      assert.match(err.message, /--profile or MNEMOS_PROFILE \(profile name or directory\)/);
      return true;
    },
  );
});
