// MNEMOS_SKIP_FOLDERS with several browsers (src/sources.ts sourcePrefix,
// src/fetcher.ts folderPrefix): results show each folder path with its
// browser's name, and its profile's when a browser is read in several, so a
// skip folder naming a browser, a browser and profile, or a full path copied
// from a result marks those pages skipped and drops their text and chunks,
// as list_folder_contents with the same name lists them. Plain folder names
// keep working, and with one browser nothing changes. Each test points every
// platform's home variable at a fresh temp dir, so the browsers' default
// paths land inside it, and runs one Fetcher per source with a fake fetch.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";
import { selectSources, sourcePrefix } from "../dist/sources.js";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher } from "../dist/fetcher.js";

const SELECTION_VARS = [
  "CHROME_BOOKMARKS_PATH",
  "CHROME_PROFILE",
  "MNEMOS_BOOKMARKS_PATH",
  "MNEMOS_PROFILE",
  "MNEMOS_BOOKMARKS_BROWSER",
];

const SECRET = "https://bank.example/statements";
const WORK = "https://work.example/roadmap";
const PERSONAL = "https://food.example/recipes";
const FIREFOX = "https://www.mozilla.org/";

let home;
const dirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  home = tempDir("mnemos-skip-prefix-");
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
  });
  for (const name of SELECTION_VARS) delete process.env[name];
  makeBrowsers();
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

const url = (name, u) => ({ type: "url", name, url: u, date_added: "13350000000000000" });

/** A Chromium profile whose Bookmarks Bar holds these nodes. */
function chromeProfile(dir, ...children) {
  write(
    path.join(browsers.chromiumBase("chrome"), dir, "Bookmarks"),
    JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "", children } } }),
  );
}

/**
 * Chrome with two profiles, Work (last used: --browser chrome reads it) with
 * a Private folder, and Personal; Firefox with one profile.
 */
function makeBrowsers() {
  chromeProfile("Default", url("Recipes", PERSONAL));
  chromeProfile("Profile 1", url("Roadmap", WORK), { type: "folder", name: "Private", children: [url("Bank", SECRET)] });
  write(
    path.join(browsers.chromiumBase("chrome"), "Local State"),
    JSON.stringify({
      profile: { last_used: "Profile 1", info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } },
    }),
  );

  const base = browsers.firefoxBase();
  write(path.join(base, "profiles.ini"), "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/aaaa\nDefault=1\n");
  const places = path.join(base, "Profiles", "aaaa", "places.sqlite");
  fs.mkdirSync(path.dirname(places), { recursive: true });
  const db = new DatabaseSync(places);
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, description TEXT);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
      parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER,
      lastModified INTEGER, guid TEXT);
  `);
  const mark = db.prepare(
    "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  mark.run(1, 2, null, 0, 0, "", 0, "root________");
  mark.run(2, 2, null, 1, 0, "toolbar", 0, "toolbar_____");
  db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)").run(10, FIREFOX, "Mozilla");
  mark.run(10, 1, 10, 2, 0, "Mozilla", 1_700_000_000_000_000, "bm-0");
  db.close();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A fake fetch: an article page at once, recording each URL fetched. */
function fakeFetch() {
  const calls = [];
  const fn = async (u, options) => {
    calls.push({ url: u, folder: options.folder });
    const paragraph = "A long and careful paragraph about the page's subject, for the extractor to keep. ".repeat(8);
    const html = `<!doctype html><html><head><title>Page</title></head><body><article><h1>Page</h1>${`<p>${paragraph}</p>`.repeat(6)}</article></body></html>`;
    return { status: "ok", kind: "html", url: u, httpStatus: 200, contentType: "text/html", charset: "utf-8", html };
  };
  return { fn, calls };
}

/**
 * Runs one Fetcher per selected source, wired as index.ts wires them, with
 * MNEMOS_SKIP_FOLDERS set to `skip`, until each is idle. Every source's index
 * starts with each page ok, its text and a chunk stored. Returns each URL's
 * page and chunks after, and the URLs fetched.
 */
async function fetchAll(skip) {
  const dir = tempDir("mnemos-skip-prefix-cache-");
  const fetch = fakeFetch();
  const pages = new Map();
  for (const source of selectSources().sources) {
    const entries = () => lib.sourceBookmarks(source);
    const bookmarksFile = () => source.bookmarks;
    const store = IndexStore.open({ bookmarksFile: source.bookmarks, dir });
    store.syncBookmarks(bookmarkRows([...entries()]));
    store.addPendingPages();
    for (const { url: u } of store.pageStates()) {
      store.upsertPage({ url: u, status: "ok", fetched_at: Date.now(), content_hash: "h", text: "page text" });
      store.replaceChunks(u, ["page text"], "h");
    }
    store.close();
    const fetcher = new Fetcher({
      env: { MNEMOS_SKIP_FOLDERS: skip },
      bookmarksFile,
      entries,
      folderPrefix: () => sourcePrefix(source),
      dir,
      fetch: fetch.fn,
      domainGapMs: 0,
      heartbeatMs: 60_000,
    });
    try {
      fetcher.start();
      await until(() => fetcher.status().state === "idle", `${source.bookmarks} to be idle`);
    } finally {
      fetcher.stop();
    }
    const after = IndexStore.open({ bookmarksFile: source.bookmarks, dir });
    try {
      for (const { url: u } of after.pageStates()) pages.set(u, { ...after.getPage(u), chunks: after.getChunks(u).length });
    } finally {
      after.close();
    }
  }
  return { pages, fetched: fetch.calls.map((c) => c.url) };
}

/** The URLs a run marked skipped for a skip folder, each with its text and chunks dropped. */
function skippedUrls(pages) {
  const skipped = [...pages].filter(([, page]) => page.status === "skipped");
  for (const [u, page] of skipped) {
    assert.equal(page.reason, "skip-folder", u);
    assert.equal(page.text, null, `${u}'s text`);
    assert.equal(page.chunks, 0, `${u}'s chunks`);
  }
  for (const [u, page] of pages) if (page.status !== "skipped") assert.equal(page.chunks, 1, `${u} keeps its chunk`);
  return skipped.map(([u]) => u).sort();
}

/** What list_folder_contents lists for `folder`. */
const listed = (folder) => lib.listFolderContents(folder).bookmarks.map((b) => b.url).sort();

test("sourcePrefix: each source's prefix in the selection now, as results show it", () => {
  const [work, personal] = ["Profile 1", "Default"].map((dir) => path.join(browsers.chromiumBase("chrome"), dir, "Bookmarks"));

  browsers.setStartupOptions({ browser: ["chrome", "firefox"] });
  assert.equal(sourcePrefix({ bookmarks: work }), "Chrome › ");
  assert.equal(sourcePrefix({ bookmarks: personal }), "", "a profile no longer read has none");

  browsers.setStartupOptions({ browser: "all" });
  assert.equal(sourcePrefix({ bookmarks: work }), "Chrome › Work › ");
  assert.equal(sourcePrefix({ bookmarks: personal }), "Chrome › Personal › ");
  assert.deepEqual(
    selectSources().sources.map((s) => sourcePrefix(s)),
    selectSources().prefixes,
  );

  browsers.setStartupOptions({ browser: ["chrome"] });
  assert.equal(sourcePrefix({ bookmarks: work }), "");
});

test("--browser chrome,firefox: a full path from a result, or a browser, skips what list_folder_contents lists", async () => {
  browsers.setStartupOptions({ browser: ["chrome", "firefox"] });
  for (const [skip, expected] of [
    ["Chrome › Bookmarks Bar › Private", [SECRET]],
    ["Chrome", [SECRET, WORK]],
    ["Firefox", [FIREFOX]],
    ["Private", [SECRET]],
  ]) {
    assert.deepEqual(listed(skip), expected, `list_folder_contents("${skip}")`);
    const { pages, fetched } = await fetchAll(skip);
    assert.deepEqual(skippedUrls(pages), expected, `MNEMOS_SKIP_FOLDERS="${skip}"`);
    assert.equal(pages.size, 3, "Chrome's Work profile and Firefox's");
    for (const u of expected) assert.ok(!fetched.includes(u), `${u} is not fetched`);
  }
});

test("--browser all over several profiles: a full path, a browser and profile, or a browser skips what list_folder_contents lists", async () => {
  browsers.setStartupOptions({ browser: "all" });
  for (const [skip, expected] of [
    ["Chrome › Work › Bookmarks Bar › Private", [SECRET]],
    ["Chrome › Work", [SECRET, WORK]],
    ["Chrome › Personal", [PERSONAL]],
    ["Chrome", [SECRET, PERSONAL, WORK]],
    ["Private", [SECRET]],
  ]) {
    assert.deepEqual(listed(skip), [...expected].sort(), `list_folder_contents("${skip}")`);
    const { pages } = await fetchAll(skip);
    assert.deepEqual(skippedUrls(pages), [...expected].sort(), `MNEMOS_SKIP_FOLDERS="${skip}"`);
    assert.equal(pages.size, 4);
  }
});

test("one browser: folder paths carry no prefix, and plain folder names work as before", async () => {
  browsers.setStartupOptions({ browser: ["chrome"] });
  let run = await fetchAll("Private");
  assert.deepEqual(skippedUrls(run.pages), [SECRET]);
  assert.deepEqual(listed("Chrome"), []);
  run = await fetchAll("Chrome");
  assert.deepEqual(skippedUrls(run.pages), [], "the browser's name is no folder of its own");
});

test("the prefix is asked at each refill: a page goes back to pending when the prefix no longer matches", async () => {
  browsers.setStartupOptions({ browser: "all" });
  const source = selectSources().sources.find((s) => s.profile?.startsWith("Work"));
  const dir = tempDir("mnemos-skip-prefix-cache-");
  const store = IndexStore.open({ bookmarksFile: source.bookmarks, dir });
  store.syncBookmarks(bookmarkRows([...lib.sourceBookmarks(source)]));
  store.close();
  let prefix = "Chrome › Work › ";
  const fetch = fakeFetch();
  const fetcher = new Fetcher({
    env: { MNEMOS_SKIP_FOLDERS: "Chrome › Work" },
    bookmarksFile: () => source.bookmarks,
    entries: () => lib.sourceBookmarks(source),
    folderPrefix: () => prefix,
    dir,
    fetch: fetch.fn,
    domainGapMs: 0,
    heartbeatMs: 60_000,
    idlePollMs: 20,
  });
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle", "the first pass");
    assert.deepEqual(fetch.calls, []);
    // Chrome's other profile is no longer read: Work's folders lose the profile's name.
    prefix = "Chrome › ";
    await until(() => fetch.calls.length === 2 && fetcher.status().state === "idle", "both pages fetched");
    assert.deepEqual(fetch.calls.map((c) => c.folder).sort(), ["Chrome › Bookmarks Bar", "Chrome › Bookmarks Bar › Private"]);
  } finally {
    fetcher.stop();
  }
});
