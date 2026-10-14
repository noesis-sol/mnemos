// The Chromium registry beyond the first five browsers: Chrome's Beta, Dev and
// Canary channels and Opera, each per platform; Opera's root-level Bookmarks
// file standing in for its Default profile; and the Snap and Flatpak
// user-data directories on Linux. Like browsers.test.js, each test points
// every platform's home variable at a fresh temp dir.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-registry-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  for (const name of [
    "CHROME_BOOKMARKS_PATH",
    "CHROME_PROFILE",
    "MNEMOS_BOOKMARKS_PATH",
    "MNEMOS_PROFILE",
    "MNEMOS_BOOKMARKS_BROWSER",
  ]) {
    delete process.env[name];
  }
});

function write(file, data) {
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const chromiumFile = (name) =>
  JSON.stringify({
    roots: { bookmark_bar: { type: "folder", name: "", children: [{ type: "url", name, url: "https://example.com/" }] } },
  });

const titles = () => lib.recentBookmarks().bookmarks.map((m) => m.title);

test("Chrome's channels and Opera: each user-data directory, per platform", () => {
  const env = {
    LOCALAPPDATA: path.join(home, "Local"),
    APPDATA: path.join(home, "Roaming"),
    XDG_CONFIG_HOME: path.join(home, "xdg"),
  };
  const mac = (...p) => path.join(home, "Library", "Application Support", ...p);
  const expected = {
    "chrome-beta": [
      mac("Google", "Chrome Beta"),
      path.join(env.LOCALAPPDATA, "Google", "Chrome Beta", "User Data"),
      path.join(env.XDG_CONFIG_HOME, "google-chrome-beta"),
    ],
    "chrome-dev": [
      mac("Google", "Chrome Dev"),
      path.join(env.LOCALAPPDATA, "Google", "Chrome Dev", "User Data"),
      path.join(env.XDG_CONFIG_HOME, "google-chrome-unstable"),
    ],
    "chrome-canary": [
      mac("Google", "Chrome Canary"),
      path.join(env.LOCALAPPDATA, "Google", "Chrome SxS", "User Data"),
      path.join(env.XDG_CONFIG_HOME, "google-chrome-canary"),
    ],
    // Opera keeps its user data under the roaming %APPDATA%, not %LOCALAPPDATA%.
    opera: [
      mac("com.operasoftware.Opera"),
      path.join(env.APPDATA, "Opera Software", "Opera Stable"),
      path.join(env.XDG_CONFIG_HOME, "opera"),
    ],
  };
  for (const [browser, [darwin, win32, linux]] of Object.entries(expected)) {
    assert.equal(browsers.chromiumBase(browser, "darwin", env), darwin, browser);
    assert.equal(browsers.chromiumBase(browser, "win32", env), win32, browser);
    assert.equal(browsers.chromiumBase(browser, "linux", env), linux, browser);
  }
  assert.deepEqual(
    Object.keys(expected).map((b) => browsers.BROWSER_NAMES[b]),
    ["Chrome Beta", "Chrome Dev", "Chrome Canary", "Opera"],
  );
  // Without APPDATA, Opera falls back to the home directory's Roaming folder.
  assert.equal(
    browsers.chromiumBase("opera", "win32", {}),
    path.join(home, "AppData", "Roaming", "Opera Software", "Opera Stable"),
  );
});

test("Chrome Beta, Dev and Canary read their own profile's Bookmarks file", () => {
  for (const browser of ["chrome-beta", "chrome-dev", "chrome-canary"]) {
    process.env.MNEMOS_BOOKMARKS_BROWSER = browser;
    const file = path.join(browsers.chromiumBase(browser), "Default", "Bookmarks");
    assert.equal(lib.bookmarksPath(), file);
    write(file, chromiumFile(`${browser} page`));
    assert.deepEqual(titles(), [`${browser} page`]);
  }
});

test("Opera: a root-level Bookmarks file is the Default profile, unless Default/ has one", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "opera";
  const base = browsers.chromiumBase("opera");
  const nested = path.join(base, "Default", "Bookmarks");
  const root = path.join(base, "Bookmarks");
  // Nothing there yet: the missing-file error names the current layout's file.
  assert.equal(lib.bookmarksPath(), nested);
  write(root, chromiumFile("older opera"));
  assert.equal(lib.bookmarksPath(), root);
  assert.deepEqual(titles(), ["older opera"]);
  assert.deepEqual(browsers.chromiumProfiles("opera"), ["Default"]);
  write(nested, chromiumFile("newer opera"));
  assert.equal(lib.bookmarksPath(), nested);
  assert.deepEqual(titles(), ["newer opera"]);
  assert.deepEqual(browsers.chromiumProfiles("opera"), ["Default"]);
});

test("Opera: another profile never falls back to the root-level file", () => {
  process.env.MNEMOS_BOOKMARKS_BROWSER = "opera";
  const base = browsers.chromiumBase("opera");
  write(path.join(base, "Bookmarks"), chromiumFile("root"));
  write(path.join(base, "Profile 2", "Bookmarks"), chromiumFile("second"));
  process.env.MNEMOS_PROFILE = "Profile 9";
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 9", "Bookmarks"));
  assert.throws(() => lib.listFolders(), /Opera profiles that have bookmarks: Default, Profile 2\./);
});

test("Chrome ignores a stray root-level Bookmarks file; only Opera reads one", () => {
  const base = browsers.chromiumBase("chrome");
  write(path.join(base, "Bookmarks"), chromiumFile("stray"));
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
  assert.deepEqual(browsers.chromiumProfiles("chrome"), []);
});

test("Linux: a Snap's or Flatpak's user-data directory is used when it holds Local State", () => {
  const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
  const native = path.join(env.XDG_CONFIG_HOME, "chromium");
  const snap = path.join(home, "snap", "chromium", "common", "chromium");
  const flatpak = path.join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium");
  assert.equal(browsers.chromiumBase("chromium", "linux", env), native);
  write(path.join(flatpak, "Local State"), "{}");
  assert.equal(browsers.chromiumBase("chromium", "linux", env), flatpak);
  write(path.join(snap, "Local State"), "{}");
  assert.equal(browsers.chromiumBase("chromium", "linux", env), snap);
  write(path.join(native, "Local State"), "{}");
  assert.equal(browsers.chromiumBase("chromium", "linux", env), native);
});

test("Linux: each Flatpak keeps the native directory names below its own config", () => {
  const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
  const flatpaks = {
    chrome: ["com.google.Chrome", "google-chrome"],
    "chrome-dev": ["com.google.ChromeDev", "google-chrome-unstable"],
    edge: ["com.microsoft.Edge", "microsoft-edge"],
    brave: ["com.brave.Browser", "BraveSoftware", "Brave-Browser"],
    vivaldi: ["com.vivaldi.Vivaldi", "vivaldi"],
    opera: ["com.opera.Opera", "opera"],
  };
  for (const [browser, [id, ...dirs]] of Object.entries(flatpaks)) {
    const dir = path.join(home, ".var", "app", id, "config", ...dirs);
    write(path.join(dir, "Local State"), "{}");
    assert.equal(browsers.chromiumBase(browser, "linux", env), dir, browser);
  }
  const brave = path.join(home, "snap", "brave", "current", ".config", "BraveSoftware", "Brave-Browser");
  fs.rmSync(path.join(home, ".var"), { recursive: true });
  write(path.join(brave, "Local State"), "{}");
  assert.equal(browsers.chromiumBase("brave", "linux", env), brave);
});

test("existing Chrome configurations resolve as before", () => {
  const base = browsers.chromiumBase("chrome");
  assert.equal(lib.bookmarksPath(), path.join(base, "Default", "Bookmarks"));
  process.env.CHROME_PROFILE = "Profile 3";
  assert.equal(lib.bookmarksPath(), path.join(base, "Profile 3", "Bookmarks"));
  process.env.CHROME_BOOKMARKS_PATH = path.join(home, "x", "Bookmarks");
  assert.equal(lib.bookmarksPath(), path.join(home, "x", "Bookmarks"));
  assert.equal(
    lib.bookmarksPath({ XDG_CONFIG_HOME: path.join(home, "xdg") }, "linux"),
    path.join(home, "xdg", "google-chrome", "Default", "Bookmarks"),
  );
});
