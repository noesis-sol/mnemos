// Chrome's bookmark encryption (src/browsers.ts, src/lib.ts): Chrome writes
// encrypted copies of a profile's Bookmarks and AccountBookmarks files
// (EncryptedBookmarks2, EncryptedAccountBookmarks) beside them, then, at the
// last stage, only the encrypted files. mnemos cannot decrypt them, so it says
// so: a profile with only encrypted files gets an error of its own (with
// several browsers, a warning), never "No bookmarks file"; a profile with one
// file kept only encrypted is read in part, with a warning; and a plain file
// older than its encrypted copy is read with a warning that it may be stale.
// Each test points every platform's home variable at a fresh temp dir, so the
// browsers' default paths land inside it.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";
import { selectSources } from "../dist/sources.js";

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-encrypted-"));
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
  return file;
}

/** A Chromium bookmarks file whose bookmarks bar holds these [title, url] bookmarks. */
const chromiumFile = (bar) =>
  JSON.stringify({
    checksum: "0",
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        children: bar.map(([name, url]) => ({ type: "url", name, url, date_added: "13350000000000000" })),
      },
      other: { type: "folder", name: "Other bookmarks", children: [] },
      synced: { type: "folder", name: "Mobile bookmarks", children: [] },
    },
    version: 1,
  });

/** What Chrome writes to an encrypted bookmarks file: "v10", then ciphertext. */
const ciphertext = () => Buffer.concat([Buffer.from("v10"), Buffer.from("23702b125ff0113d918b722bd5990ef8e95e122ec2de2760", "hex")]);

const profileDir = (browser, profile) => path.join(browsers.chromiumBase(browser), profile);
const makeFile = (browser, profile, name, bar) => write(path.join(profileDir(browser, profile), name), chromiumFile(bar));
const makeEncrypted = (browser, profile, name) => write(path.join(profileDir(browser, profile), name), ciphertext());

/** Sets a file's modification time `ms` milliseconds before now. */
function age(file, ms) {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(file, at, at);
}

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Only encrypted files (the last stage)
// ---------------------------------------------------------------------------

test("only encrypted: the profile gets its own error, naming the encrypted file and what to do", () => {
  const encrypted = makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.throws(
    () => lib.listFolders(),
    (e) => {
      assert.match(e.message, /^Chrome keeps the bookmarks of profile Default encrypted/);
      assert.ok(e.message.includes(encrypted), e.message);
      assert.ok(e.message.includes(path.join(profileDir("chrome", "Default"), "Bookmarks")), e.message);
      assert.match(e.message, /chrome:\/\/flags lists "Bookmarks Encryption"/);
      assert.match(e.message, /--profile or MNEMOS_PROFILE/);
      assert.doesNotMatch(e.message, /No bookmarks file/);
      assert.doesNotMatch(e.message, /profiles that have bookmarks: none/);
      return true;
    },
  );
});

test("only encrypted: a synced profile's two encrypted files are both named", () => {
  const local = makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  const account = makeEncrypted("chrome", "Default", "EncryptedAccountBookmarks");
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.throws(() => lib.searchBookmarks("x"), (e) => e.message.includes(`(${local}, ${account})`));
});

test("only encrypted: the profile counts as one with bookmarks, for --profile, the default profile and the profile list", () => {
  makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  makeEncrypted("chrome", "Profile 2", "EncryptedBookmarks2");
  write(
    path.join(browsers.chromiumBase("chrome"), "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Work" } } } }),
  );
  assert.deepEqual(browsers.chromiumProfileLabels("chrome"), ["Personal (Default)", "Work (Profile 2)"]);
  browsers.setStartupOptions({ browser: ["chrome"], profile: "work" });
  assert.equal(selectSources().sources[0].profile, "Work (Profile 2)");
  assert.throws(() => lib.listFolders(), /Chrome keeps the bookmarks of profile Work \(Profile 2\) encrypted/);

  // A profile directory with no bookmarks at all is still reported as missing.
  browsers.setStartupOptions({ browser: ["chrome"], profile: "Nope" });
  assert.throws(() => lib.listFolders(), /No bookmarks file at .*Chrome profiles that have bookmarks: Personal \(Default\), Work \(Profile 2\)\./);
});

test("only encrypted: with several browsers, the profile is a warning and the rest are read", () => {
  makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  makeFile("edge", "Default", "Bookmarks", [["Edge page", "https://edge.example/"]]);
  for (const browser of ["all", ["chrome", "edge"]]) {
    browsers.setStartupOptions({ browser });
    const result = lib.searchBookmarks("edge");
    assert.deepEqual(result.matches.map((m) => m.title), ["Edge page"]);
    assert.equal(result.warnings.length, 1, String(browser));
    assert.match(result.warnings[0], /^Chrome: Chrome keeps the bookmarks of profile Default encrypted/);
    assert.doesNotMatch(result.warnings[0], /No bookmarks file/);
  }
});

test("only encrypted: Edge's error points at edge://flags", () => {
  makeEncrypted("edge", "Default", "EncryptedBookmarks2");
  browsers.setStartupOptions({ browser: ["edge"] });
  assert.throws(() => lib.listFolders(), /Edge keeps the bookmarks .*edge:\/\/flags lists/);
});

// ---------------------------------------------------------------------------
// One of the two files kept only encrypted
// ---------------------------------------------------------------------------

test("one file encrypted: a synced profile's plain AccountBookmarks is read, with a warning that the device's bookmarks are not", () => {
  const encrypted = makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  makeEncrypted("chrome", "Default", "EncryptedAccountBookmarks");
  makeFile("chrome", "Default", "AccountBookmarks", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  browsers.setStartupOptions({ browser: ["chrome"] });
  const result = lib.searchBookmarks("rust");
  assert.deepEqual(result.matches.map((m) => [m.title, m.folder]), [["Rust book", "Account Bookmarks Bar"]]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^Chrome: Chrome keeps the bookmarks kept only on this device encrypted/);
  assert.ok(result.warnings[0].includes(encrypted), result.warnings[0]);
});

test("one file encrypted: a plain Bookmarks is read, with a warning that the account's bookmarks are not", () => {
  makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  const encrypted = makeEncrypted("chrome", "Default", "EncryptedAccountBookmarks");
  browsers.setStartupOptions({ browser: ["chrome"] });
  const result = lib.listFolders();
  assert.equal(result.total_bookmarks, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /the bookmarks saved to the Google account encrypted/);
  assert.ok(result.warnings[0].includes(encrypted), result.warnings[0]);
});

// ---------------------------------------------------------------------------
// Plain files beside their encrypted copies
// ---------------------------------------------------------------------------

test("both written: plain files written with their encrypted copies are read without a warning", () => {
  makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  makeFile("chrome", "Default", "AccountBookmarks", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  makeEncrypted("chrome", "Default", "EncryptedAccountBookmarks");
  makeEncrypted("chrome", "Default", "EncryptedBookmarks2.bak");
  browsers.setStartupOptions({ browser: ["chrome"] });
  const result = lib.searchBookmarks("https");
  assert.equal(result.total_matches, 2);
  assert.equal("warnings" in result, false);
});

test("stale: a plain Bookmarks older than its encrypted copy is read, with a warning that it may be out of date", () => {
  const plain = makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  const encrypted = makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  age(plain, 2 * HOUR);
  browsers.setStartupOptions({ browser: ["chrome"] });
  const result = lib.searchBookmarks("recipes");
  assert.deepEqual(result.matches.map((m) => m.title), ["Recipes"]);
  assert.equal(result.warnings.length, 1);
  const [warning] = result.warnings;
  assert.ok(warning.startsWith(`Chrome: ${plain} was last written `), warning);
  assert.ok(warning.includes(`before Chrome's encrypted copy ${encrypted}`), warning);
  assert.match(warning, /the bookmarks kept only on this device may be out of date/);
});

test("stale: the newest encrypted copy counts, and a plain file within a minute of it is not stale", () => {
  const plain = makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  const old = makeEncrypted("chrome", "Default", "EncryptedBookmarks");
  const current = makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  age(old, 3 * HOUR);
  age(plain, 30 * 1000);
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.equal("warnings" in lib.listFolders(), false);
  assert.deepEqual(browsers.chromiumEncryptedBookmarks(profileDir("chrome", "Default")), { bookmarks: current });

  age(plain, 2 * HOUR);
  assert.match(lib.listFolders().warnings[0], new RegExp(`encrypted copy ${current.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
});

test("stale: a stale AccountBookmarks, with several browsers, is named under its profile", () => {
  makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  const account = makeFile("chrome", "Default", "AccountBookmarks", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  makeEncrypted("chrome", "Default", "EncryptedAccountBookmarks");
  age(account, 2 * HOUR);
  makeFile("edge", "Default", "Bookmarks", [["Edge page", "https://edge.example/"]]);
  browsers.setStartupOptions({ browser: "all" });
  const result = lib.searchBookmarks("https");
  assert.equal(result.total_matches, 3);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].startsWith(`Chrome: ${account} was last written `), result.warnings[0]);
  assert.match(result.warnings[0], /the bookmarks saved to the Google account may be out of date/);
});

test("a file named by MNEMOS_BOOKMARKS_PATH is read as it is, its directory's encrypted files left alone", () => {
  const plain = makeFile("chrome", "Default", "Bookmarks", [["Recipes", "https://food.example/"]]);
  makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  age(plain, 2 * HOUR);
  process.env.MNEMOS_BOOKMARKS_PATH = plain;
  assert.equal("warnings" in lib.listFolders(), false);
});

// ---------------------------------------------------------------------------
// Over MCP
// ---------------------------------------------------------------------------

test("e2e: the server answers an encrypted-only profile with the encryption error", async () => {
  makeEncrypted("chrome", "Default", "EncryptedBookmarks2");
  const env = { ...process.env, MNEMOS_EMBEDDER: "fake", MNEMOS_FETCH_PAGES: "0", MNEMOS_CACHE_DIR: path.join(home, "cache"), ...homeEnv() };
  for (const name of SELECTION_VARS) delete env[name];
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, "--browser", "chrome"], env }));
  try {
    const result = await client.callTool({ name: "list_folders", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Chrome keeps the bookmarks of profile Default encrypted/);
    assert.doesNotMatch(result.content[0].text, /No bookmarks file/);
  } finally {
    await client.close();
  }
});
