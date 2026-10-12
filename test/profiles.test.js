// Profile resolution against a fake Chrome directory: CHROME_PROFILE picking
// <chrome dir>/<profile>/Bookmarks, the missing-file error listing the profiles
// that have bookmarks, and an empty CHROME_BOOKMARKS_PATH falling back to the
// profile. Each test points every platform's home variable (HOME, USERPROFILE,
// XDG_CONFIG_HOME, LOCALAPPDATA) at a fresh temp dir, so lib.chromeBase()
// lands inside it on macOS, Linux and Windows alike. node:test runs each test
// file in its own process, so mutating process.env here cannot leak into
// other test files.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";

const roots = (name) => ({
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "",
      children: [{ type: "url", name, url: `https://${name}.example/` }],
    },
  },
});

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-profiles-"));
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  delete process.env.CHROME_BOOKMARKS_PATH;
  delete process.env.CHROME_PROFILE;
});

/** The fake Chrome directory, checked to sit inside this test's temp home. */
function chromeDir() {
  const base = lib.chromeBase();
  assert.ok(base.startsWith(home + path.sep), `${base} is not under ${home}`);
  return base;
}

/** Create <chrome dir>/<profile>, with a Bookmarks file naming `name` if given. */
function makeProfile(profile, name) {
  const dir = path.join(chromeDir(), profile);
  fs.mkdirSync(dir, { recursive: true });
  if (name !== undefined) fs.writeFileSync(path.join(dir, "Bookmarks"), JSON.stringify(roots(name)));
}

const bookmarkNames = () => lib.loadRoots().bookmark_bar.children.map((c) => c.name);

test("CHROME_PROFILE='Profile 3' reads <chrome dir>/Profile 3/Bookmarks", () => {
  makeProfile("Default", "default-one");
  makeProfile("Profile 3", "profile-three");
  process.env.CHROME_PROFILE = "Profile 3";
  assert.equal(lib.bookmarksPath(), path.join(chromeDir(), "Profile 3", "Bookmarks"));
  assert.deepEqual(bookmarkNames(), ["profile-three"]);
});

test("without CHROME_PROFILE the Default profile is read", () => {
  makeProfile("Default", "default-one");
  makeProfile("Profile 3", "profile-three");
  assert.deepEqual(bookmarkNames(), ["default-one"]);
});

test("a missing profile's error lists the profiles with a Bookmarks file, sorted", () => {
  makeProfile("Profile 2", "two");
  makeProfile("Default", "default-one");
  makeProfile("Profile 1", "one");
  makeProfile("Guest Profile"); // no Bookmarks file: must not be listed
  fs.writeFileSync(path.join(chromeDir(), "Local State"), "{}"); // a file, not a profile
  process.env.CHROME_PROFILE = "Profile 9";
  const missing = path.join(chromeDir(), "Profile 9", "Bookmarks");
  assert.throws(
    () => lib.loadRoots(),
    (err) => {
      assert.ok(err.message.includes(`No bookmarks file at ${missing}.`), err.message);
      assert.ok(
        err.message.includes("Chrome profiles that have bookmarks: Default, Profile 1, Profile 2."),
        err.message,
      );
      assert.ok(!err.message.includes("Guest Profile"), err.message);
      assert.ok(err.message.includes("Set CHROME_PROFILE"), err.message);
      return true;
    },
  );
});

test("the error says 'none' when the Chrome directory does not exist", () => {
  assert.ok(!fs.existsSync(chromeDir()));
  process.env.CHROME_PROFILE = "Profile 3";
  assert.throws(() => lib.loadRoots(), /Chrome profiles that have bookmarks: none\./);
});

test("the error says 'none' when no profile has a Bookmarks file", () => {
  makeProfile("Default");
  makeProfile("Profile 1");
  assert.throws(() => lib.loadRoots(), /Chrome profiles that have bookmarks: none\./);
});

test("an empty CHROME_BOOKMARKS_PATH falls back to the profile", () => {
  makeProfile("Default", "default-one");
  makeProfile("Profile 3", "profile-three");
  process.env.CHROME_BOOKMARKS_PATH = "";
  process.env.CHROME_PROFILE = "Profile 3";
  assert.equal(lib.bookmarksPath(), path.join(chromeDir(), "Profile 3", "Bookmarks"));
  assert.deepEqual(bookmarkNames(), ["profile-three"]);
});
