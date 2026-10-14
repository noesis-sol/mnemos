// The --browser and --profile startup flags: parsing, their precedence over
// MNEMOS_BOOKMARKS_BROWSER, MNEMOS_PROFILE and CHROME_PROFILE, the
// MNEMOS_BOOKMARKS_PATH / CHROME_BOOKMARKS_PATH alias, and the built server
// started with the flags. Each test points every platform's home variable at
// a fresh temp dir, so the browsers' default paths land inside it.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = path.join(ROOT, "dist", "index.js");

const SELECTION_VARS = [
  "CHROME_BOOKMARKS_PATH",
  "CHROME_PROFILE",
  "MNEMOS_BOOKMARKS_PATH",
  "MNEMOS_PROFILE",
  "MNEMOS_BOOKMARKS_BROWSER",
];

let home;

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-flags-"));
  Object.assign(process.env, homeEnv());
  for (const name of SELECTION_VARS) delete process.env[name];
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

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseStartupArgs: --browser and --profile, spaced or with =, browser case ignored", () => {
  assert.deepEqual(browsers.parseStartupArgs([]), {});
  assert.deepEqual(browsers.parseStartupArgs(["--browser", "edge"]), { browser: "edge" });
  assert.deepEqual(browsers.parseStartupArgs(["--browser=Chrome-Canary", "--profile=Profile 2"]), {
    browser: "chrome-canary",
    profile: "Profile 2",
  });
  assert.deepEqual(browsers.parseStartupArgs(["--profile", "Work"]), { profile: "Work" });
  // An empty --profile means the browser's default, like an empty MNEMOS_PROFILE.
  assert.deepEqual(browsers.parseStartupArgs(["--profile="]), {});
});

test("parseStartupArgs: an unknown browser, flag or stray argument is an error", () => {
  assert.throws(
    () => browsers.parseStartupArgs(["--browser", "netscape"]),
    /--browser is "netscape"; use one of: chrome, chrome-beta, chrome-dev, chrome-canary, chromium, edge, brave, vivaldi, opera, firefox, safari\./,
  );
  assert.throws(() => browsers.parseStartupArgs(["--browser="]), /--browser is ""; use one of/);
  assert.throws(() => browsers.parseStartupArgs(["--browsers", "edge"]), /Unknown option '--browsers'/);
  assert.throws(() => browsers.parseStartupArgs(["edge"]), /edge/);
  assert.throws(() => browsers.parseStartupArgs(["--browser"]), /--browser/);
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test("--browser wins over MNEMOS_BOOKMARKS_BROWSER", () => {
  const env = { ...homeEnv(), MNEMOS_BOOKMARKS_BROWSER: "brave" };
  assert.equal(browsers.selectedBrowser(env, {}), "brave");
  assert.equal(browsers.selectedBrowser(env, { browser: "edge" }), "edge");
  // A flag also overrides an invalid variable, which is then never read.
  assert.equal(browsers.selectedBrowser({ MNEMOS_BOOKMARKS_BROWSER: "netscape" }, { browser: "opera" }), "opera");
  assert.equal(
    lib.bookmarksPath(env, process.platform, { browser: "edge" }),
    path.join(browsers.chromiumBase("edge"), "Default", "Bookmarks"),
  );
});

test("--profile wins over MNEMOS_PROFILE, which wins over CHROME_PROFILE", () => {
  const base = browsers.chromiumBase("chrome");
  const at = (profile) => path.join(base, profile, "Bookmarks");
  const env = { ...homeEnv(), CHROME_PROFILE: "Old" };
  assert.equal(lib.bookmarksPath(env, process.platform, {}), at("Old"));
  env.MNEMOS_PROFILE = "New";
  assert.equal(lib.bookmarksPath(env, process.platform, {}), at("New"));
  assert.equal(lib.bookmarksPath(env, process.platform, { profile: "Flag" }), at("Flag"));
  env.MNEMOS_PROFILE = "";
  assert.equal(lib.bookmarksPath(env, process.platform, {}), at("Old"));
  env.CHROME_PROFILE = "";
  assert.equal(lib.bookmarksPath(env, process.platform, {}), at("Default"));
});

test("MNEMOS_BOOKMARKS_PATH wins over CHROME_BOOKMARKS_PATH; either wins over the flags", () => {
  const options = { browser: "edge", profile: "Work" };
  assert.equal(lib.bookmarksPath({ CHROME_BOOKMARKS_PATH: "/old/Bookmarks" }, "linux", options), "/old/Bookmarks");
  assert.equal(
    lib.bookmarksPath({ CHROME_BOOKMARKS_PATH: "/old/Bookmarks", MNEMOS_BOOKMARKS_PATH: "/new/Bookmarks" }, "linux", options),
    "/new/Bookmarks",
  );
  assert.equal(
    lib.bookmarksPath({ CHROME_BOOKMARKS_PATH: "/old/Bookmarks", MNEMOS_BOOKMARKS_PATH: "" }, "linux", options),
    "/old/Bookmarks",
  );
});

test("--profile picks a Firefox profile by name", () => {
  const base = browsers.firefoxBase();
  write(
    path.join(base, "profiles.ini"),
    "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/a.default\nDefault=1\n\n" +
      "[Profile1]\nName=work\nIsRelative=1\nPath=Profiles/b.work\n",
  );
  process.env.CHROME_PROFILE = "default";
  browsers.setStartupOptions({ browser: "firefox", profile: "work" });
  assert.equal(lib.bookmarksPath(), path.join(base, "Profiles", "b.work", "places.sqlite"));
});

test("setStartupOptions: later lookups use the flags; a missing profile lists the flag's browser's profiles", () => {
  write(path.join(browsers.chromiumBase("edge"), "Profile 4", "Bookmarks"), chromiumFile("edge page"));
  write(path.join(browsers.chromiumBase("brave"), "Default", "Bookmarks"), chromiumFile("brave page"));
  process.env.MNEMOS_BOOKMARKS_BROWSER = "brave";
  assert.deepEqual(lib.recentBookmarks().bookmarks.map((b) => b.title), ["brave page"]);
  browsers.setStartupOptions({ browser: "edge" });
  assert.throws(
    () => lib.listFolders(),
    (err) => {
      assert.match(err.message, /Edge profiles that have bookmarks: Profile 4\./);
      assert.match(err.message, /Choose one with --profile or MNEMOS_PROFILE/);
      assert.match(err.message, /Other browsers with bookmarks here: Brave \(choose one with --browser or MNEMOS_BOOKMARKS_BROWSER: brave\)\./);
      return true;
    },
  );
  browsers.setStartupOptions({ browser: "edge", profile: "Profile 4" });
  assert.deepEqual(lib.recentBookmarks().bookmarks.map((b) => b.title), ["edge page"]);
});

// ---------------------------------------------------------------------------
// The built server
// ---------------------------------------------------------------------------

// Index in a scratch cache with the fake embedder: never the user's cache, never the real model.
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-cache-"));
const INDEX_ENV = { MNEMOS_CACHE_DIR: CACHE, MNEMOS_EMBEDDER: "fake", MNEMOS_FETCH_PAGES: "0" };
after(() => {
  try {
    fs.rmSync(CACHE, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // a temporary directory left behind
  }
});

function serverEnv(env) {
  const base = { ...process.env, ...INDEX_ENV, ...homeEnv(), TZ: "UTC" };
  for (const name of SELECTION_VARS) delete base[name];
  return { ...base, ...env };
}

test("e2e flags: the server reads the browser and profile its flags name, over the environment", async () => {
  write(path.join(browsers.chromiumBase("edge"), "Work", "Bookmarks"), chromiumFile("edge work page"));
  write(path.join(browsers.chromiumBase("brave"), "Home", "Bookmarks"), chromiumFile("brave home page"));
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--browser", "edge", "--profile", "Work"],
      env: serverEnv({ MNEMOS_BOOKMARKS_BROWSER: "brave", MNEMOS_PROFILE: "Home" }),
    }),
  );
  try {
    const result = await client.callTool({ name: "recent_bookmarks", arguments: {} });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(JSON.parse(result.content[0].text).bookmarks.map((b) => b.title), ["edge work page"]);
  } finally {
    await client.close();
  }
});

test("e2e flags: an unknown --browser stops the server at startup, naming the choices", () => {
  const run = spawnSync(process.execPath, [SERVER, "--browser", "netscape"], {
    env: serverEnv({}),
    input: "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /mnemos: --browser is "netscape"; use one of: chrome, /);
});
