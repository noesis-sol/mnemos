// Chrome's account bookmarks (src/browsers.ts, src/sources.ts, src/lib.ts,
// src/indexer.ts): since Chrome 146, bookmarks saved to the Google account
// are kept in the profile's AccountBookmarks file beside its Bookmarks file.
// Both are read, the account's roots under labels of their own; a profile
// with only AccountBookmarks is a profile with bookmarks; and the index
// re-syncs when either file changes. Each test points every platform's home
// variable at a fresh temp dir, so the browsers' default paths land inside it.
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
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer, bookmarkRows } from "../dist/indexer.js";
import { semanticSearch } from "../dist/semantic.js";

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-account-"));
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

const url = ([name, href, guid]) => ({
  type: "url",
  name,
  url: href,
  date_added: "13350000000000000",
  ...(guid ? { guid } : {}),
});

/**
 * A Chromium bookmarks file as Chrome writes it: the three roots, the
 * bookmarks bar holding `bar` and a "Work" folder holding `work`, and the
 * non-tree values beside the roots.
 */
const chromiumFile = (bar, work = []) =>
  JSON.stringify({
    checksum: "0",
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        children: [...bar.map(url), { type: "folder", name: "Work", children: work.map(url) }],
      },
      other: { type: "folder", name: "Other bookmarks", children: [] },
      synced: { type: "folder", name: "Mobile bookmarks", children: [] },
    },
    sync_transaction_version: "1",
    version: 1,
  });

const profileDir = (browser, profile) => path.join(browsers.chromiumBase(browser), profile);

/** A profile's Bookmarks file with these bookmarks; returns its path. */
function makeLocal(browser, profile, bar, work) {
  const file = path.join(profileDir(browser, profile), "Bookmarks");
  write(file, chromiumFile(bar, work));
  return file;
}

/** A profile's AccountBookmarks file with these bookmarks; returns its path. */
function makeAccount(browser, profile, bar, work) {
  const file = path.join(profileDir(browser, profile), "AccountBookmarks");
  write(file, chromiumFile(bar, work));
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

// ---------------------------------------------------------------------------
// Both files
// ---------------------------------------------------------------------------

test("both files: every tool reads the account's bookmarks too, its folders under their own paths", () => {
  const local = makeLocal("chrome", "Default", [["Recipes", "https://food.example/"]], [["Local plan", "https://plan.example/local"]]);
  const account = makeAccount(
    "chrome",
    "Default",
    [["Rust book", "https://doc.rust-lang.org/book/"]],
    [["Account plan", "https://plan.example/account"]],
  );
  browsers.setStartupOptions({ browser: ["chrome"] });

  const folders = lib.listFolders();
  assert.deepEqual(folders.folders.map((f) => [f.folder, f.bookmarks]), [
    ["Account Bookmarks Bar", 1],
    ["Account Bookmarks Bar › Work", 1],
    ["Account Mobile Bookmarks", 0],
    ["Account Other Bookmarks", 0],
    ["Bookmarks Bar", 1],
    ["Bookmarks Bar › Work", 1],
    ["Mobile Bookmarks", 0],
    ["Other Bookmarks", 0],
  ]);
  assert.equal(folders.total_bookmarks, 4);
  assert.deepEqual(folders.sources, [
    { browser: "chrome", profile: "Default", bookmarks: local, account_bookmarks: account },
  ]);

  // The folder filters match a folder of either file.
  assert.deepEqual(lib.listFolderContents("work").bookmarks.map((b) => [b.title, b.folder]), [
    ["Local plan", "Bookmarks Bar › Work"],
    ["Account plan", "Account Bookmarks Bar › Work"],
  ]);
  assert.deepEqual(lib.searchBookmarks("plan", "account").matches.map((b) => b.title), ["Account plan"]);
  assert.deepEqual(lib.searchBookmarks("rust").matches.map((b) => b.folder), ["Account Bookmarks Bar"]);
  assert.equal(lib.recentBookmarks().total_matches, 4);
  assert.deepEqual(
    lib.topDomains().domains.map((d) => d.domain).sort(),
    ["doc.rust-lang.org", "food.example", "plan.example"],
  );
});

test("both files: with several browsers, the account's roots follow the browser's name", () => {
  makeLocal("chrome", "Default", [["Recipes", "https://food.example/"]]);
  makeAccount("chrome", "Default", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  makeLocal("edge", "Default", [["Edge page", "https://edge.example/"]]);
  browsers.setStartupOptions({ browser: "all" });
  assert.deepEqual(lib.searchBookmarks("https").matches.map((b) => b.folder).sort(), [
    "Chrome › Account Bookmarks Bar",
    "Chrome › Bookmarks Bar",
    "Edge › Bookmarks Bar",
  ]);
});

test("both files: a file named by MNEMOS_BOOKMARKS_PATH is the one file read", () => {
  const local = makeLocal("chrome", "Default", [["Recipes", "https://food.example/"]]);
  makeAccount("chrome", "Default", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  process.env.MNEMOS_BOOKMARKS_PATH = local;
  const result = lib.searchBookmarks("https");
  assert.deepEqual(result.matches.map((b) => b.title), ["Recipes"]);
  assert.deepEqual(result.sources, [{ browser: null, profile: null, bookmarks: local }]);
});

test("both files: an AccountBookmarks file that is not valid JSON is an error, like a Bookmarks file", () => {
  makeLocal("chrome", "Default", [["Recipes", "https://food.example/"]]);
  const account = path.join(profileDir("chrome", "Default"), "AccountBookmarks");
  write(account, "{ half a file");
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.throws(() => lib.listFolders(), (e) => e.message.includes(account) && /not valid JSON/.test(e.message));
});

// ---------------------------------------------------------------------------
// A profile with only AccountBookmarks
// ---------------------------------------------------------------------------

test("only AccountBookmarks: found as the default profile, by --profile, by --browser all and in the missing-profile error", () => {
  makeLocal("chrome", "Default", [["Recipes", "https://food.example/"]]);
  const account = makeAccount("chrome", "Profile 1", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  const local = path.join(profileDir("chrome", "Profile 1"), "Bookmarks");
  localState("chrome", "Profile 1", { Default: "Personal", "Profile 1": "Work" });
  const work = { browser: "chrome", profile: "Work (Profile 1)", bookmarks: local, account_bookmarks: account };

  // The default profile: the one Chrome last used.
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.deepEqual(selectSources().sources, [work]);
  const search = lib.searchBookmarks("rust");
  assert.deepEqual(search.matches.map((b) => b.folder), ["Account Bookmarks Bar"]);
  assert.deepEqual(search.sources, [work]);

  // By directory and by display name.
  for (const profile of ["Profile 1", "Work", "work"]) {
    browsers.setStartupOptions({ browser: ["chrome"], profile });
    assert.deepEqual(selectSources().sources, [work], profile);
  }

  // --browser all: its default profile first.
  browsers.setStartupOptions({ browser: "all" });
  assert.deepEqual(selectSources().sources.map((s) => s.profile), ["Work (Profile 1)", "Personal (Default)"]);
  assert.deepEqual(lib.listFolders().folders.filter((f) => f.bookmarks > 0).map((f) => f.folder), [
    "Chrome › Personal › Bookmarks Bar",
    "Chrome › Work › Account Bookmarks Bar",
  ]);
  assert.deepEqual(browsers.browsersWithBookmarks(undefined), ["chrome"]);

  // The missing-profile error lists it.
  browsers.setStartupOptions({ browser: ["chrome"], profile: "Nope" });
  assert.throws(() => lib.listFolders(), /Chrome profiles that have bookmarks: Personal \(Default\), Work \(Profile 1\)\./);
});

test("only AccountBookmarks: the default profile when Local State names none", () => {
  const account = makeAccount("chrome", "Default", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.deepEqual(lib.searchBookmarks("rust").sources, [
    {
      browser: "chrome",
      profile: "Default",
      bookmarks: path.join(profileDir("chrome", "Default"), "Bookmarks"),
      account_bookmarks: account,
    },
  ]);
});

test("only AccountBookmarks: Opera's Default profile is not taken for its root-level Bookmarks file", () => {
  write(path.join(browsers.chromiumBase("opera"), "Bookmarks"), chromiumFile([["Old root", "https://root.example/"]]));
  makeAccount("opera", "Default", [["Account page", "https://account.example/"]]);
  browsers.setStartupOptions({ browser: ["opera"] });
  assert.deepEqual(lib.searchBookmarks("https").matches.map((b) => b.title), ["Account page"]);
});

// ---------------------------------------------------------------------------
// Following changes
// ---------------------------------------------------------------------------

test("cache: the parsed roots are read again when the AccountBookmarks file appears or changes", () => {
  makeLocal("chrome", "Default", [["Recipes", "https://food.example/"]]);
  browsers.setStartupOptions({ browser: ["chrome"] });
  const [source] = selectSources().sources;
  assert.equal("account_bookmarks" in source, false);
  assert.deepEqual(lib.sourceFiles(source), [source.bookmarks, path.join(profileDir("chrome", "Default"), "AccountBookmarks")]);
  const titles = () => [...lib.sourceBookmarks(source)].map((e) => e.node.name);
  assert.deepEqual(titles(), ["Recipes"]);
  // The same source object, as an index holds it, sees the file appear...
  const account = makeAccount("chrome", "Default", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  assert.deepEqual(titles(), ["Recipes", "Rust book"]);
  // ...change, and go when the user signs out.
  write(account, chromiumFile([["Rust book", "https://doc.rust-lang.org/book/"], ["Go tour", "https://go.dev/tour/"]]));
  assert.deepEqual(titles(), ["Recipes", "Rust book", "Go tour"]);
  fs.rmSync(account);
  assert.deepEqual(titles(), ["Recipes"]);
});

test("index: re-syncs when either file changes, and finds the account's bookmarks", async () => {
  makeLocal("chrome", "Default", [["Sourdough starter", "https://bread.example/sourdough", "11111111-0000-4000-8000-000000000001"]]);
  browsers.setStartupOptions({ browser: ["chrome"] });
  const [source] = selectSources().sources;
  const embedder = new FakeEmbedder();
  const indexer = new Indexer({
    embedder,
    bookmarksFile: () => source.bookmarks,
    files: () => lib.sourceFiles(source),
    entries: () => lib.sourceBookmarks(source),
    dir: path.join(home, "cache"),
    debounceMs: 5,
  });
  const ctx = { embedder, indexes: () => ({ indexer }), env: {} };
  const found = async (query) => (await semanticSearch(ctx, query)).results.map((r) => [r.title, r.folder]);
  try {
    indexer.start();
    await indexer.idle();
    assert.equal(indexer.status().titles_total, 1);

    makeAccount("chrome", "Default", [["Kayak trips", "https://kayak.example/", "22222222-0000-4000-8000-000000000002"]]);
    indexer.checkForChanges();
    await indexer.idle();
    assert.equal(indexer.status().titles_total, 2, "the account file appearing re-syncs the index");
    assert.deepEqual(await found("kayak"), [["Kayak trips", "Account Bookmarks Bar"]]);

    makeAccount("chrome", "Default", [], [["Kayak trips", "https://kayak.example/", "22222222-0000-4000-8000-000000000002"]]);
    indexer.checkForChanges();
    await indexer.idle();
    assert.deepEqual(await found("kayak"), [["Kayak trips", "Account Bookmarks Bar › Work"]]);

    makeLocal("chrome", "Default", []);
    indexer.checkForChanges();
    await indexer.idle();
    assert.equal(indexer.status().titles_total, 1, "the Bookmarks file changing re-syncs it too");
  } finally {
    indexer.close();
  }
});

test("index: a guid met in both files keeps one row each", () => {
  const guid = "33333333-0000-4000-8000-000000000003";
  const rows = bookmarkRows([
    { folder: "Bookmarks Bar", node: url(["Local copy", "https://same.example/", guid]) },
    { folder: "Account Bookmarks Bar", node: url(["Account copy", "https://same.example/", guid]) },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].guid, guid);
  assert.notEqual(rows[1].guid, guid);
  assert.equal(new Set(rows.map((r) => r.guid)).size, 2);
  assert.deepEqual(rows.map((r) => r.folder_path), ["Bookmarks Bar", "Account Bookmarks Bar"]);
});

// ---------------------------------------------------------------------------
// Over MCP
// ---------------------------------------------------------------------------

test("e2e: the server's tools and semantic_search return bookmarks from both files", async () => {
  const local = makeLocal("chrome", "Default", [["Rust by example", "https://doc.rust-lang.org/rust-by-example/"]]);
  const account = makeAccount("chrome", "Default", [["Rust book", "https://doc.rust-lang.org/book/"]]);
  const env = { ...process.env, MNEMOS_EMBEDDER: "fake", MNEMOS_FETCH_PAGES: "0", MNEMOS_CACHE_DIR: path.join(home, "cache"), ...homeEnv() };
  for (const name of SELECTION_VARS) delete env[name];
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, "--browser", "chrome"], env }));
  try {
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text);
    };
    const search = await call("search_bookmarks", { query: "rust" });
    assert.deepEqual(search.matches.map((m) => [m.title, m.folder]), [
      ["Rust by example", "Bookmarks Bar"],
      ["Rust book", "Account Bookmarks Bar"],
    ]);
    assert.deepEqual(search.sources, [{ browser: "chrome", profile: "Default", bookmarks: local, account_bookmarks: account }]);
    const semantic = await call("semantic_search", { query: "rust" });
    assert.deepEqual(semantic.results.map((r) => r.title).sort(), ["Rust book", "Rust by example"]);
  } finally {
    await client.close();
  }
});
