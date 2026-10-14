// Choosing the browsers to read: --browser / MNEMOS_BOOKMARKS_BROWSER as
// default, an id, a comma-separated list or all; its precedence and the
// CHROME_PROFILE / CHROME_BOOKMARKS_PATH compatibility rule; the startup checks
// (a profile or a bookmarks file applies to one browser); the sources each
// selection reads (src/sources.ts), the default browser injected rather than
// detected; every tool's `sources` and `warnings`, in process and over MCP;
// and semantic_search over one index per source. Each test points every
// platform's home variable at a fresh temp dir, so the browsers' default
// paths land inside it.
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
import { selectSources } from "../dist/sources.js";
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer } from "../dist/indexer.js";
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-selection-"));
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

const chromiumFile = (...bookmarks) =>
  JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "",
        children: bookmarks.map(([name, url]) => ({ type: "url", name, url, date_added: "13350000000000000" })),
      },
    },
  });

/** A Chromium browser's profile with these bookmarks; returns its Bookmarks file. */
function makeProfile(browser, profile, ...bookmarks) {
  const file = path.join(browsers.chromiumBase(browser), profile, "Bookmarks");
  write(file, chromiumFile(...bookmarks));
  return file;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("selection: default, all, an id or a comma-separated list; case, spaces and repeats ignored", () => {
  const parse = (value) => browsers.parseBrowserSelection(value, "--browser");
  assert.equal(parse("default"), "default");
  assert.equal(parse(" Default "), "default");
  assert.equal(parse("ALL"), "all");
  assert.deepEqual(parse("firefox"), ["firefox"]);
  assert.deepEqual(parse("Chrome, firefox ,EDGE"), ["chrome", "firefox", "edge"]);
  assert.deepEqual(parse("edge,edge"), ["edge"]);
  assert.deepEqual(browsers.parseStartupArgs(["--browser", "chrome,safari"]), { browser: ["chrome", "safari"] });
  assert.deepEqual(browsers.parseStartupArgs(["--browser=all"]), { browser: "all" });
});

test("selection: an unknown id is an error listing the valid ids; default and all stand alone", () => {
  const ids = "chrome, chrome-beta, chrome-dev, chrome-canary, chromium, edge, brave, vivaldi, opera, firefox, librewolf, waterfox, zen, floorp, tor-browser, safari";
  assert.throws(
    () => browsers.parseBrowserSelection("netscape", "--browser"),
    { message: `--browser is "netscape"; use default, all, or one or more of these, separated by commas: ${ids}.` },
  );
  assert.throws(
    () => browsers.parseBrowserSelection("chrome,netscape,mosaic", "MNEMOS_BOOKMARKS_BROWSER"),
    /^Error: MNEMOS_BOOKMARKS_BROWSER is "chrome,netscape,mosaic" \("netscape", "mosaic" unknown\); use default, all/,
  );
  assert.throws(() => browsers.parseBrowserSelection("default,firefox", "--browser"), /\("default" unknown\)/);
  assert.throws(() => browsers.parseBrowserSelection("chrome,,edge", "--browser"), /\("" unknown\)/);
  assert.throws(() => browsers.parseBrowserSelection("all,chrome", "--browser"), /\("all" unknown\)/);
});

// ---------------------------------------------------------------------------
// Precedence and compatibility
// ---------------------------------------------------------------------------

test("precedence: --browser, then MNEMOS_BOOKMARKS_BROWSER, then Chrome for CHROME_*, else the default browser", () => {
  const select = browsers.selectedBrowsers;
  assert.equal(select({}, {}), "default");
  assert.equal(select({ MNEMOS_BOOKMARKS_BROWSER: " " }, {}), "default", "an empty variable is unset");
  assert.deepEqual(select({ CHROME_PROFILE: "Work" }, {}), ["chrome"]);
  assert.deepEqual(select({ CHROME_BOOKMARKS_PATH: "/x/Bookmarks" }, {}), ["chrome"]);
  assert.equal(select({ CHROME_PROFILE: "", CHROME_BOOKMARKS_PATH: "" }, {}), "default", "empty CHROME_* are unset");
  // MNEMOS_PROFILE and MNEMOS_BOOKMARKS_PATH are not the old names: they do not mean Chrome.
  assert.equal(select({ MNEMOS_PROFILE: "Work", MNEMOS_BOOKMARKS_PATH: "/x/Bookmarks" }, {}), "default");
  assert.deepEqual(select({ CHROME_PROFILE: "Work", MNEMOS_BOOKMARKS_BROWSER: "firefox" }, {}), ["firefox"]);
  assert.equal(select({ CHROME_PROFILE: "Work", MNEMOS_BOOKMARKS_BROWSER: "all" }, {}), "all");
  assert.deepEqual(select({ MNEMOS_BOOKMARKS_BROWSER: "all" }, { browser: ["edge", "brave"] }), ["edge", "brave"]);
  assert.equal(select({ MNEMOS_BOOKMARKS_BROWSER: "edge" }, { browser: "default" }), "default");
  assert.equal(select({ CHROME_BOOKMARKS_PATH: "/x/Bookmarks" }, { browser: "all" }), "all");
});

test("compatibility: CHROME_PROFILE alone reads that Chrome profile, never detecting the default browser", () => {
  const file = makeProfile("chrome", "Profile 2", ["chrome page", "https://example.com/"]);
  const detect = () => assert.fail("the default browser was detected");
  const { sources, warnings } = selectSources({ env: { ...process.env, CHROME_PROFILE: "Profile 2" }, detect });
  assert.deepEqual(sources, [{ browser: "chrome", profile: "Profile 2", bookmarks: file }]);
  assert.deepEqual(warnings, []);
  const byPath = selectSources({ env: { ...process.env, CHROME_BOOKMARKS_PATH: file }, detect });
  assert.deepEqual(byPath.sources, [{ browser: "chrome", profile: null, bookmarks: file }]);
  // MNEMOS_BOOKMARKS_PATH reads its file as it is, whichever browser wrote it.
  const generic = selectSources({ env: { ...process.env, MNEMOS_BOOKMARKS_PATH: file }, detect });
  assert.deepEqual(generic.sources, [{ browser: null, profile: null, bookmarks: file }]);
});

test("startup check: a profile or a bookmarks file applies to one browser only", () => {
  const check = browsers.checkSelection;
  // One browser, the default browser included: fine.
  check({ MNEMOS_PROFILE: "Work" }, {});
  check({}, { browser: ["edge"], profile: "Work" });
  check({ CHROME_PROFILE: "Work" }, {});
  check({ MNEMOS_BOOKMARKS_PATH: "/x/Bookmarks" }, { browser: ["firefox"] });
  check({}, { browser: "all" });
  assert.throws(
    () => check({}, { browser: ["chrome", "firefox"], profile: "Work" }),
    { message: '--profile ("Work") picks a profile of one browser, but --browser is "chrome,firefox". Choose one browser, or leave the profile out to read each browser\'s default profile.' },
  );
  assert.throws(() => check({ MNEMOS_PROFILE: "Work", MNEMOS_BOOKMARKS_BROWSER: "all" }, {}), /^Error: MNEMOS_PROFILE \("Work"\) .* but MNEMOS_BOOKMARKS_BROWSER is "all"/);
  assert.throws(() => check({ CHROME_PROFILE: "Old" }, { browser: "all" }), /^Error: CHROME_PROFILE \("Old"\) .* but --browser is "all"/);
  assert.throws(
    () => check({ CHROME_BOOKMARKS_PATH: "/x/Bookmarks" }, { browser: ["edge", "brave"] }),
    { message: 'CHROME_BOOKMARKS_PATH names one bookmarks file, but --browser is "edge,brave". Unset one of them.' },
  );
  assert.throws(() => check({ MNEMOS_BOOKMARKS_BROWSER: "lynx" }, {}), /MNEMOS_BOOKMARKS_BROWSER is "lynx"/);
});

// ---------------------------------------------------------------------------
// The sources each selection reads
// ---------------------------------------------------------------------------

test("default: the detected browser in its last-used profile, labelled by its display name", () => {
  const base = browsers.chromiumBase("edge");
  const file = makeProfile("edge", "Profile 1", ["edge page", "https://example.com/"]);
  write(
    path.join(base, "Local State"),
    JSON.stringify({ profile: { last_used: "Profile 1", info_cache: { "Profile 1": { name: "Work" } } } }),
  );
  const detect = () => ({ browser: "edge" });
  assert.deepEqual(selectSources({ detect }), {
    sources: [{ browser: "edge", profile: "Work (Profile 1)", bookmarks: file }],
    failures: [],
    warnings: [],
    multi: false,
  });
  // --profile applies to the default browser.
  const other = makeProfile("edge", "Default", ["other", "https://example.org/"]);
  assert.equal(selectSources({ detect, options: { profile: "Default" } }).sources[0].bookmarks, other);
  // Detection's fallback warning travels with the source; its error is the tool's error.
  const warned = selectSources({ detect: () => ({ browser: "edge", warning: "Could not detect the system default browser" }) });
  assert.deepEqual(warned.warnings, ["Could not detect the system default browser"]);
  assert.throws(
    () => selectSources({ detect: () => { throw new Error("The system default browser is Arc"); } }),
    /The system default browser is Arc/,
  );
});

test("default over the tools: results report the detected browser's source", () => {
  const file = makeProfile("brave", "Default", ["brave page", "https://example.com/"]);
  const bookmarks = lib.readBookmarks({ detect: () => ({ browser: "brave", warning: "fell back to Brave" }) });
  assert.deepEqual(bookmarks.report, {
    sources: [{ browser: "brave", profile: "Default", bookmarks: file }],
    warnings: ["fell back to Brave"],
  });
  assert.deepEqual([...lib.allBookmarks(bookmarks)].map((e) => e.folder), ["Bookmarks Bar"], "one browser: no prefix");
});

test("a list: each browser in its default profile; one that cannot be found or read is a warning", () => {
  const chrome = makeProfile("chrome", "Default", ["chrome page", "https://chrome.example/"]);
  browsers.setStartupOptions({ browser: ["chrome", "firefox", "edge"] });
  const selection = selectSources();
  assert.equal(selection.multi, true);
  assert.deepEqual(selection.failures.map((f) => f.browser), ["firefox"], "no profiles.ini");
  assert.deepEqual(selection.sources.map((s) => s.browser), ["chrome", "edge"]);

  const bookmarks = lib.readBookmarks();
  assert.deepEqual(bookmarks.report.sources, [{ browser: "chrome", profile: "Default", bookmarks: chrome }]);
  assert.equal(bookmarks.report.warnings.length, 2);
  assert.match(bookmarks.report.warnings[0], /^Firefox: No Firefox profiles found: no profiles.ini in /);
  assert.match(bookmarks.report.warnings[1], /^Edge: No bookmarks file at .*Default.Bookmarks\. Edge profiles that have bookmarks: none\./);
  assert.doesNotMatch(bookmarks.report.warnings[1], /Other browsers with bookmarks here/, "a list names no others");
  assert.deepEqual([...lib.allBookmarks(bookmarks)].map((e) => e.folder), ["Chrome › Bookmarks Bar"]);
});

test("a list where no browser can be read is an error naming each", () => {
  browsers.setStartupOptions({ browser: ["edge", "brave"] });
  assert.throws(() => lib.listFolders(), /^Error: None of the selected browsers' bookmarks could be read\. Edge: No bookmarks file .* Brave: No bookmarks file/s);
});

test("one browser that cannot be read stays an error, as before", () => {
  browsers.setStartupOptions({ browser: ["edge"] });
  assert.throws(() => lib.listFolders(), /^Error: No bookmarks file at .*Edge profiles that have bookmarks: none/s);
});

test("all: every browser with bookmarks here, each in its default profile; none is an error", () => {
  browsers.setStartupOptions({ browser: "all" });
  assert.throws(() => selectSources(), /No supported browser has bookmarks here \(--browser all\)/);
  const edge = makeProfile("edge", "Default", ["edge page", "https://edge.example/"]);
  const vivaldi = makeProfile("vivaldi", "Default", ["vivaldi page", "https://vivaldi.example/"]);
  const { sources, multi } = selectSources();
  assert.equal(multi, true);
  assert.deepEqual(sources, [
    { browser: "edge", profile: "Default", bookmarks: edge },
    { browser: "vivaldi", profile: "Default", bookmarks: vivaldi },
  ]);
  // Even one browser found reads as a selection of several: its folders carry its name.
  fs.rmSync(path.dirname(vivaldi), { recursive: true });
  assert.deepEqual(lib.listFolders().folders.map((f) => f.folder), ["Edge › Bookmarks Bar"]);
});

// ---------------------------------------------------------------------------
// Every tool's sources and warnings, in process
// ---------------------------------------------------------------------------

/** Chrome's and Edge's Default profiles with a bookmark each, and Brave selected but missing. */
function twoBrowsers() {
  const chrome = makeProfile("chrome", "Default", ["Rust book", "https://doc.rust-lang.org/book/"]);
  const edge = makeProfile("edge", "Default", ["Rust by example", "https://doc.rust-lang.org/rust-by-example/"]);
  return {
    chrome,
    edge,
    sources: [
      { browser: "chrome", profile: "Default", bookmarks: chrome },
      { browser: "edge", profile: "Default", bookmarks: edge },
    ],
  };
}

const TOOLS = {
  search_bookmarks: () => lib.searchBookmarks("rust"),
  list_folders: () => lib.listFolders(),
  list_folder_contents: () => lib.listFolderContents("Bookmarks Bar"),
  recent_bookmarks: () => lib.recentBookmarks(),
  top_domains: () => lib.topDomains(),
};

for (const [name, fn] of Object.entries(TOOLS)) {
  test(`${name}: reports its sources, a warning for the one it could not read, and names each browser`, () => {
    const { sources } = twoBrowsers();
    browsers.setStartupOptions({ browser: ["chrome", "edge", "brave"] });
    const result = fn();
    assert.deepEqual(result.sources, sources);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Brave: No bookmarks file at /);
    if (name === "top_domains") assert.deepEqual(result.domains, [{ domain: "doc.rust-lang.org", bookmarks: 2 }]);
    else if (name === "list_folders") {
      assert.deepEqual(result.folders.map((f) => f.folder), ["Chrome › Bookmarks Bar", "Edge › Bookmarks Bar"]);
    } else {
      const items = result.matches ?? result.bookmarks;
      assert.deepEqual(items.map((b) => b.folder).sort(), ["Chrome › Bookmarks Bar", "Edge › Bookmarks Bar"]);
    }

    // One browser: its source, and no warnings at all.
    browsers.setStartupOptions({ browser: ["edge"] });
    const one = fn();
    assert.deepEqual(one.sources, [sources[1]]);
    assert.equal("warnings" in one, false);
  });
}

test("a folder filter matches the browser's name in the path", () => {
  twoBrowsers();
  browsers.setStartupOptions({ browser: ["chrome", "edge"] });
  assert.deepEqual(lib.searchBookmarks("rust", "edge").matches.map((m) => m.title), ["Rust by example"]);
  assert.deepEqual(lib.listFolderContents("chrome").bookmarks.map((m) => m.title), ["Rust book"]);
});

// ---------------------------------------------------------------------------
// semantic_search over one index per source
// ---------------------------------------------------------------------------

test("semantic_search: each source's own index, ranked as one library, with sources and warnings", async () => {
  const chrome = makeProfile(
    "chrome",
    "Default",
    ["Watercolor basics", "https://paint.example/watercolor"],
    ["Tax forms", "https://tax.example/forms"],
  );
  const edge = makeProfile(
    "edge",
    "Default",
    ["Sourdough starter", "https://bread.example/sourdough"],
    ["Train timetable", "https://rail.example/times"],
  );
  browsers.setStartupOptions({ browser: ["chrome", "edge", "brave"] });
  const cache = path.join(home, "cache");
  const embedder = new FakeEmbedder();
  const made = new Map();
  const indexes = (source) => {
    if (!made.has(source.bookmarks)) {
      const indexer = new Indexer({
        embedder,
        bookmarksFile: () => source.bookmarks,
        entries: () => lib.sourceBookmarks(source),
        dir: cache,
      });
      indexer.start();
      made.set(source.bookmarks, { indexer });
    }
    return made.get(source.bookmarks);
  };
  try {
    // The first call makes and starts each source's index.
    await semanticSearch({ embedder, indexes, env: {} }, "anything");
    for (const { indexer } of made.values()) await indexer.idle();
    assert.deepEqual([...made.keys()], [chrome, edge], "one index per bookmarks file read");

    const data = await semanticSearch({ embedder, indexes, env: {} }, "aquarelle");
    assert.equal(data.status.search, "semantic");
    assert.equal(data.results[0].title, "Watercolor basics");
    assert.equal(data.results[0].matched_on, "title");
    assert.equal(data.results[0].folder, "Chrome › Bookmarks Bar");
    assert.equal(data.status.progress, "titles 4/4 · pages 0/4", "both indexes added up");
    assert.equal(data.status.indexing, "ready");
    assert.deepEqual(data.sources, [
      { browser: "chrome", profile: "Default", bookmarks: chrome },
      { browser: "edge", profile: "Default", bookmarks: edge },
    ]);
    assert.equal(data.warnings.length, 1);
    assert.match(data.warnings[0], /^Brave: No bookmarks file at /);

    const bread = await semanticSearch({ embedder, indexes, env: {} }, "sourdough");
    assert.equal(bread.results[0].title, "Sourdough starter");
    assert.equal(bread.results[0].folder, "Edge › Bookmarks Bar");
    assert.equal(bread.results[0].matched_on, "keyword");

    // A source's index keys its bookmarks without the prefix: the same file alone needs no new vectors.
    browsers.setStartupOptions({ browser: ["edge"] });
    const alone = await semanticSearch({ embedder, indexes, env: {} }, "sourdough");
    assert.equal(alone.results[0].folder, "Bookmarks Bar");
    assert.equal(alone.status.progress, "titles 2/2 · pages 0/2");
    assert.deepEqual(alone.sources, [{ browser: "edge", profile: "Default", bookmarks: edge }]);
    assert.equal("warnings" in alone, false);
  } finally {
    for (const { indexer } of made.values()) indexer.close();
  }
});

// ---------------------------------------------------------------------------
// The built server
// ---------------------------------------------------------------------------

// Index in a scratch cache with the fake embedder: never the user's cache, never the real model.
const INDEX_ENV = { MNEMOS_EMBEDDER: "fake", MNEMOS_FETCH_PAGES: "0" };

function serverEnv(env) {
  const base = { ...process.env, ...INDEX_ENV, MNEMOS_CACHE_DIR: path.join(home, "cache"), ...homeEnv(), TZ: "UTC" };
  for (const name of SELECTION_VARS) delete base[name];
  return { ...base, ...env };
}

const CALLS = {
  search_bookmarks: { query: "rust" },
  semantic_search: { query: "rust" },
  list_folders: {},
  list_folder_contents: { folder: "Bookmarks Bar" },
  recent_bookmarks: {},
  top_domains: {},
};

test("e2e: every tool reports its sources and the warning for a browser it could not read", async () => {
  const { sources } = twoBrowsers();
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--browser", "chrome,edge,firefox"],
      env: serverEnv({ MNEMOS_BOOKMARKS_BROWSER: "safari" }),
    }),
  );
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(CALLS).sort(), "every tool is checked");
    for (const [name, args] of Object.entries(CALLS)) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(data.sources, sources, name);
      assert.equal(data.warnings?.length, 1, name);
      assert.match(data.warnings[0], /^Firefox: No Firefox profiles found/, name);
    }
    const instructions = client.getInstructions();
    assert.match(instructions, /`sources`/);
    assert.match(instructions, /`warnings`/);
  } finally {
    await client.close();
  }
});

test("e2e: with one browser, every tool reports that one source and no warnings", async () => {
  const { sources } = twoBrowsers();
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER], env: serverEnv({ CHROME_PROFILE: "Default" }) }),
  );
  try {
    for (const [name, args] of Object.entries(CALLS)) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(data.sources, [sources[0]], name);
      assert.equal("warnings" in data, false, name);
    }
  } finally {
    await client.close();
  }
});

test("e2e: --profile with several browsers stops the server at startup", () => {
  const run = spawnSync(process.execPath, [SERVER, "--browser", "chrome,edge", "--profile", "Work"], {
    env: serverEnv({}),
    input: "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /mnemos: --profile \("Work"\) picks a profile of one browser, but --browser is "chrome,edge"\./);
});
