// The system default browser (src/default-browser.ts): the tables mapping
// macOS bundle ids, Windows ProgIds and Linux .desktop names to browser ids;
// detection with each command's output injected (osascript, reg query,
// xdg-settings) and its file fallbacks (LaunchServices preferences fixtures in
// test/fixtures/default-browser, mimeapps.list files in a temp dir); the
// fallback to the first browser with bookmarks when detection fails; the
// error for a default browser mnemos cannot read; detection run once.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSERS } from "../dist/browsers.js";
import * as db from "../dist/default-browser.js";

const FIXTURES = fileURLToPath(new URL("fixtures/default-browser/", import.meta.url));

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-default-browser-"));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
  });
  db.resetDefaultBrowser();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  db.resetDefaultBrowser();
});

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** A Linux environment whose XDG directories are all inside the temp home. */
const linuxEnv = () => ({
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CONFIG_DIRS: path.join(home, "etc", "xdg"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_DATA_DIRS: path.join(home, "usr", "share"),
});

/** A run() answering each command from `answers` (a string, or a function of the args), and throwing for the rest. */
function runner(answers) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const answer = answers[command];
    const out = typeof answer === "function" ? answer(args) : answer;
    if (out === undefined) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    return out;
  };
  return { run, calls };
}

const fails = () => {
  throw new Error("command failed");
};

/** reg query's output for a ProgId value. */
const regOutput = (key, progId) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\${key}\r\n` +
  `    ProgId    REG_SZ    ${progId}\r\n\r\n`;

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

test("tables: every mapped id is a browser mnemos reads", () => {
  for (const table of [db.MAC_BUNDLE_IDS, db.WINDOWS_PROGIDS, db.LINUX_DESKTOP_FILES]) {
    for (const [key, browser] of Object.entries(table)) {
      assert.ok(BROWSERS.includes(browser), `${key} maps to ${browser}`);
    }
  }
});

test("tables: every browser is reachable on each platform it runs on", () => {
  const values = (table) => new Set(Object.values(table));
  assert.deepEqual([...values(db.MAC_BUNDLE_IDS)].sort(), [...BROWSERS].sort());
  const notSafari = BROWSERS.filter((b) => b !== "safari").sort();
  assert.deepEqual([...values(db.WINDOWS_PROGIDS)].sort(), notSafari);
  assert.deepEqual([...values(db.LINUX_DESKTOP_FILES)].sort(), notSafari);
});

test("tables: keys are lower case and no key is both supported and unsupported", () => {
  const pairs = [
    [db.MAC_BUNDLE_IDS, db.MAC_UNSUPPORTED],
    [db.WINDOWS_PROGIDS, db.WINDOWS_UNSUPPORTED],
    [db.LINUX_DESKTOP_FILES, db.LINUX_UNSUPPORTED],
  ];
  for (const [supported, unsupported] of pairs) {
    for (const key of [...Object.keys(supported), ...Object.keys(unsupported)]) {
      assert.equal(key, key.toLowerCase());
    }
    for (const key of Object.keys(unsupported)) assert.ok(!(key in supported), key);
  }
});

test("identify: macOS bundle ids, in any case", () => {
  const cases = {
    "com.google.Chrome": "chrome",
    "com.google.chrome": "chrome",
    "com.google.Chrome.canary": "chrome-canary",
    "com.microsoft.edgemac": "edge",
    "com.brave.Browser": "brave",
    "com.operasoftware.Opera": "opera",
    "org.mozilla.firefox": "firefox",
    "com.apple.Safari": "safari",
  };
  for (const [id, browser] of Object.entries(cases)) {
    assert.deepEqual(db.identifyBrowser("darwin", id), { browser }, id);
  }
  assert.deepEqual(db.identifyBrowser("darwin", "company.thebrowser.Browser"), { unsupported: "Arc" });
  assert.deepEqual(db.identifyBrowser("darwin", "com.kagi.kagimacOS"), { unsupported: "Orion" });
  assert.deepEqual(db.identifyBrowser("darwin", "com.example.Surf"), { unknown: "com.example.Surf" });
});

test("identify: Windows ProgIds, with or without an install's suffix", () => {
  const cases = {
    ChromeHTML: "chrome",
    ChromeBHTML: "chrome-beta",
    ChromeDHTML: "chrome-dev",
    ChromeSSHTM: "chrome-canary",
    "ChromiumHTM.ABCDEFGHIJKL": "chromium",
    MSEdgeHTM: "edge",
    BraveHTML: "brave",
    "VivaldiHTM.KJD3WQXYZ": "vivaldi",
    OperaStable: "opera",
    "FirefoxURL-308046B0AF4A39CB": "firefox",
  };
  for (const [id, browser] of Object.entries(cases)) {
    assert.deepEqual(db.identifyBrowser("win32", id), { browser }, id);
  }
  assert.deepEqual(db.identifyBrowser("win32", "Opera GXStable"), { unsupported: "Opera GX" });
  assert.deepEqual(db.identifyBrowser("win32", "MSEdgeBHTML"), { unsupported: "Edge Beta" });
  // A ProgId that only starts like a known one is not that one.
  assert.deepEqual(db.identifyBrowser("win32", "ChromeHTMLX"), { unknown: "ChromeHTMLX" });
});

test("identify: Linux .desktop names of packages, Snaps and Flatpaks", () => {
  const cases = {
    "google-chrome.desktop": "chrome",
    "com.google.Chrome.desktop": "chrome",
    "google-chrome-unstable.desktop": "chrome-dev",
    "chromium-browser.desktop": "chromium",
    "chromium_chromium.desktop": "chromium",
    "org.chromium.Chromium.desktop": "chromium",
    "brave_brave.desktop": "brave",
    "vivaldi-stable.desktop": "vivaldi",
    "firefox.desktop": "firefox",
    "firefox_firefox.desktop": "firefox",
    "org.mozilla.firefox.desktop": "firefox",
    "firefox-esr": "firefox",
  };
  for (const [id, browser] of Object.entries(cases)) {
    assert.deepEqual(db.identifyBrowser("linux", id), { browser }, id);
  }
  assert.deepEqual(db.identifyBrowser("linux", "librewolf.desktop"), { unsupported: "LibreWolf" });
  assert.deepEqual(db.identifyBrowser("linux", "org.gnome.Epiphany.desktop"), { unsupported: "GNOME Web" });
  assert.deepEqual(db.identifyBrowser("linux", "surf.desktop"), { unknown: "surf.desktop" });
});

// ---------------------------------------------------------------------------
// Detection: macOS
// ---------------------------------------------------------------------------

test("macOS: LaunchServices' answer through osascript", () => {
  const { run, calls } = runner({ osascript: "com.brave.Browser\n" });
  assert.deepEqual(db.detectDefaultBrowserId({ platform: "darwin", home, run }), {
    id: "com.brave.Browser",
    source: "LaunchServices",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["osascript", "-l", "JavaScript", "-e"]);
  assert.match(calls[0][4], /URLForApplicationToOpenURL/);
});

const prefsFile = () =>
  path.join(home, "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist");

test("macOS: without osascript, the https handler in LaunchServices' preferences", () => {
  write(prefsFile(), fs.readFileSync(path.join(FIXTURES, "launchservices-brave.plist")));
  const { run } = runner({});
  assert.deepEqual(db.detectDefaultBrowserId({ platform: "darwin", home, run }), {
    id: "com.brave.browser",
    source: "LaunchServices preferences",
  });
});

test("macOS: an empty osascript answer also falls back to the preferences", () => {
  write(prefsFile(), fs.readFileSync(path.join(FIXTURES, "launchservices-brave.plist")));
  const { run } = runner({ osascript: "\n" });
  assert.equal(db.detectDefaultBrowserId({ platform: "darwin", home, run }).id, "com.brave.browser");
});

test("macOS: no https entry, or no preferences file, means Safari", () => {
  const { run } = runner({});
  assert.equal(db.detectDefaultBrowserId({ platform: "darwin", home, run }).id, "com.apple.Safari");
  write(prefsFile(), fs.readFileSync(path.join(FIXTURES, "launchservices-no-https.plist")));
  assert.equal(db.detectDefaultBrowserId({ platform: "darwin", home, run }).id, "com.apple.Safari");
});

test("macOS: unreadable preferences are a detection failure, not Safari", () => {
  write(prefsFile(), "not a plist");
  const { run } = runner({});
  const result = db.detectDefaultBrowserId({ platform: "darwin", home, run });
  assert.ok("failure" in result);
  assert.match(result.failure, /launchservices\.secure\.plist/);
});

// ---------------------------------------------------------------------------
// Detection: Windows
// ---------------------------------------------------------------------------

test("Windows: UserChoiceLatest wins over UserChoice", () => {
  const { run, calls } = runner({
    reg: (args) => regOutput(args[1].endsWith("UserChoiceLatest") ? "UserChoiceLatest" : "UserChoice",
      args[1].endsWith("UserChoiceLatest") ? "FirefoxURL-308046B0AF4A39CB" : "ChromeHTML"),
  });
  assert.deepEqual(db.detectDefaultBrowserId({ platform: "win32", home, run }), {
    id: "FirefoxURL-308046B0AF4A39CB",
    source: "registry (UserChoiceLatest)",
  });
  assert.deepEqual(calls[0], [
    "reg",
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoiceLatest",
    "/v",
    "ProgId",
  ]);
});

test("Windows: UserChoice when there is no UserChoiceLatest key", () => {
  const { run } = runner({
    reg: (args) => (args[1].endsWith("UserChoiceLatest") ? fails() : regOutput("UserChoice", "MSEdgeHTM")),
  });
  assert.deepEqual(db.detectDefaultBrowserId({ platform: "win32", home, run }), {
    id: "MSEdgeHTM",
    source: "registry (UserChoice)",
  });
});

test("Windows: a ProgId with spaces is read whole", () => {
  const { run } = runner({ reg: regOutput("UserChoiceLatest", "Opera GXStable") });
  assert.equal(db.detectDefaultBrowserId({ platform: "win32", home, run }).id, "Opera GXStable");
});

test("Windows: no key, or no ProgId value, is a detection failure", () => {
  assert.ok("failure" in db.detectDefaultBrowserId({ platform: "win32", home, run: runner({}).run }));
  const { run } = runner({ reg: "\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    Hash    REG_SZ    abc=\r\n" });
  assert.ok("failure" in db.detectDefaultBrowserId({ platform: "win32", home, run }));
});

// ---------------------------------------------------------------------------
// Detection: Linux
// ---------------------------------------------------------------------------

test("Linux: xdg-settings' answer", () => {
  const { run, calls } = runner({ "xdg-settings": "firefox_firefox.desktop\n" });
  assert.deepEqual(db.detectDefaultBrowserId({ platform: "linux", env: linuxEnv(), home, run }), {
    id: "firefox_firefox.desktop",
    source: "xdg-settings",
  });
  assert.deepEqual(calls, [["xdg-settings", "get", "default-web-browser"]]);
});

test("Linux: without xdg-settings, x-scheme-handler/https from mimeapps.list", () => {
  const env = linuxEnv();
  const file = path.join(env.XDG_CONFIG_HOME, "mimeapps.list");
  write(
    file,
    "[Added Associations]\nx-scheme-handler/https=chromium.desktop;\n\n" +
      "[Default Applications]\ntext/html=firefox.desktop\nx-scheme-handler/https=brave-browser.desktop;firefox.desktop;\n",
  );
  const { run } = runner({});
  assert.deepEqual(db.detectDefaultBrowserId({ platform: "linux", env, home, run }), {
    id: "brave-browser.desktop",
    source: file,
  });
});

test("Linux: an empty xdg-settings answer also falls back to mimeapps.list", () => {
  const env = linuxEnv();
  write(path.join(env.XDG_CONFIG_HOME, "mimeapps.list"), "[Default Applications]\nx-scheme-handler/https=vivaldi-stable.desktop\n");
  const { run } = runner({ "xdg-settings": "\n" });
  assert.equal(db.detectDefaultBrowserId({ platform: "linux", env, home, run }).id, "vivaldi-stable.desktop");
});

test("Linux: the desktop's own mimeapps.list first, then the user's, then the system's", () => {
  const env = { ...linuxEnv(), XDG_CURRENT_DESKTOP: "ubuntu:GNOME" };
  const run = runner({}).run;
  const detect = () => db.detectDefaultBrowserId({ platform: "linux", env, home, run }).id;
  const handler = (id) => `[Default Applications]\nx-scheme-handler/https=${id}\n`;

  write(path.join(env.XDG_DATA_DIRS, "applications", "mimeapps.list"), handler("chromium.desktop"));
  assert.equal(detect(), "chromium.desktop");
  write(path.join(env.XDG_DATA_HOME, "applications", "mimeapps.list"), handler("opera.desktop"));
  assert.equal(detect(), "opera.desktop");
  write(path.join(env.XDG_CONFIG_DIRS, "mimeapps.list"), handler("microsoft-edge.desktop"));
  assert.equal(detect(), "microsoft-edge.desktop");
  write(path.join(env.XDG_CONFIG_HOME, "mimeapps.list"), "[Default Applications]\ntext/html=firefox.desktop\n");
  assert.equal(detect(), "microsoft-edge.desktop", "a user file without the key does not stop the search");
  write(path.join(env.XDG_CONFIG_HOME, "mimeapps.list"), handler("firefox.desktop"));
  assert.equal(detect(), "firefox.desktop");
  write(path.join(env.XDG_CONFIG_HOME, "gnome-mimeapps.list"), handler("google-chrome.desktop"));
  assert.equal(detect(), "google-chrome.desktop");
  write(path.join(env.XDG_CONFIG_HOME, "ubuntu-mimeapps.list"), handler("brave_brave.desktop"));
  assert.equal(detect(), "brave_brave.desktop");
});

test("Linux: no xdg-settings and no mimeapps.list is a detection failure (WSL, minimal hosts)", () => {
  const result = db.detectDefaultBrowserId({ platform: "linux", env: linuxEnv(), home, run: runner({}).run });
  assert.ok("failure" in result);
  assert.match(result.failure, /xdg-settings/);
});

// ---------------------------------------------------------------------------
// Resolution: supported, fallback, unsupported
// ---------------------------------------------------------------------------

test("resolve: a detected browser mnemos reads", () => {
  const { run } = runner({ osascript: "org.mozilla.firefox\n" });
  const installed = () => assert.fail("the fallback is not consulted");
  assert.deepEqual(db.resolveDefaultBrowser({ platform: "darwin", home, run, installed }), {
    browser: "firefox",
    detected: { id: "org.mozilla.firefox", source: "LaunchServices" },
  });
});

test("resolve: detection failing reads the first browser with bookmarks, with a warning", () => {
  const result = db.resolveDefaultBrowser({
    platform: "linux",
    env: linuxEnv(),
    home,
    run: runner({}).run,
    installed: () => ["edge", "firefox"],
  });
  assert.equal(result.browser, "edge");
  assert.equal(result.detected, undefined);
  assert.match(result.warning, /Could not detect the system default browser/);
  assert.match(result.warning, /reading Edge, the first browser with bookmarks/);
  assert.match(result.warning, /--browser <id>/);
});

test("resolve: the fallback looks for bookmarks on this machine by default", () => {
  const env = linuxEnv();
  write(
    path.join(env.XDG_CONFIG_HOME, "vivaldi", "Default", "Bookmarks"),
    JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "", children: [] } } }),
  );
  const result = db.resolveDefaultBrowser({ platform: "linux", env, home, run: runner({}).run });
  assert.equal(result.browser, "vivaldi");
  assert.match(result.warning, /reading Vivaldi/);
});

test("resolve: detection failing with no browser to fall back on is an error", () => {
  assert.throws(
    () =>
      db.resolveDefaultBrowser({ platform: "win32", home, run: runner({}).run, installed: () => [] }),
    (e) =>
      /Could not detect the system default browser/.test(e.message) &&
      /no supported browser has bookmarks here/.test(e.message) &&
      /--browser <id>/.test(e.message) &&
      /MNEMOS_BOOKMARKS_PATH/.test(e.message),
  );
});

test("resolve: a known browser mnemos cannot read is an error naming it, never a fallback", () => {
  const { run } = runner({ osascript: "company.thebrowser.Browser\n" });
  assert.throws(
    () => db.resolveDefaultBrowser({ platform: "darwin", home, run, installed: () => ["chrome", "safari"] }),
    (e) =>
      /The system default browser is Arc \(company\.thebrowser\.Browser, from LaunchServices\)/.test(e.message) &&
      /cannot read/.test(e.message) &&
      /--browser <id>/.test(e.message) &&
      /Browsers with bookmarks here: chrome, safari\./.test(e.message),
  );
});

test("resolve: a browser mnemos does not know is an error naming what the OS said", () => {
  const { run } = runner({ "xdg-settings": "surf.desktop\n" });
  assert.throws(
    () => db.resolveDefaultBrowser({ platform: "linux", env: linuxEnv(), home, run, installed: () => [] }),
    (e) =>
      /The system default browser is "surf\.desktop" \(from xdg-settings\)/.test(e.message) &&
      /--browser <id>/.test(e.message) &&
      !/Browsers with bookmarks here/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// Once per process
// ---------------------------------------------------------------------------

test("defaultBrowser: detects on the first call only", () => {
  const { run, calls } = runner({ reg: regOutput("UserChoiceLatest", "BraveHTML") });
  const options = { platform: "win32", home, run, installed: () => [] };
  assert.equal(db.defaultBrowser(options).browser, "brave");
  assert.equal(db.defaultBrowser(options).browser, "brave");
  assert.equal(calls.length, 1);
  db.resetDefaultBrowser();
  db.defaultBrowser(options);
  assert.equal(calls.length, 2);
});

test("defaultBrowser: an error is remembered too", () => {
  const { run, calls } = runner({ osascript: "com.kagi.kagimacOS" });
  const options = { platform: "darwin", home, run, installed: () => [] };
  assert.throws(() => db.defaultBrowser(options), /Orion/);
  assert.throws(() => db.defaultBrowser(options), /Orion/);
  assert.equal(calls.length, 1);
});
