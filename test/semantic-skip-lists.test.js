// semantic_search and the skip lists of the process asking (src/semantic.ts):
// a bookmarks file's index, and the page text in it, are shared by every mnemos
// process on the machine, and only the fetcher lease holder applies its own
// MNEMOS_SKIP_DOMAINS / MNEMOS_SKIP_FOLDERS. So the page text here is stored
// as a holder with no skip list left it, and each search's ctx.env carries the
// asking process's skip lists: a page they cover is found by its title alone,
// with no snippet. In process (dist/semantic.js) with the fake embedder; each
// test points every platform's home variable at a fresh temp dir, so the
// browsers' default paths land inside it.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeEmbedder, fakeVector } from "../dist/embedder.js";
import { IndexStore } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { semanticSearch } from "../dist/semantic.js";
import * as lib from "../dist/lib.js";
import * as browsers from "../dist/browsers.js";

const SELECTION_VARS = [
  "CHROME_BOOKMARKS_PATH",
  "CHROME_PROFILE",
  "MNEMOS_BOOKMARKS_PATH",
  "MNEMOS_PROFILE",
  "MNEMOS_BOOKMARKS_BROWSER",
];

const BANK = "https://bank.example/statements";
const FOOD = "https://food.example/recipes";
const BANK_TEXT = "Overdraft fees and mortgage interest, month by month. ".repeat(4);
const FOOD_TEXT = "Sourdough starter, fed daily, and a long rise. ".repeat(4);

let home;
const dirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  home = tempDir("mnemos-semantic-skip-");
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
  });
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

const url = (name, u) => ({ type: "url", name, url: u, date_added: "13350000000000000" });

/** A Chromium browser's Default profile whose Bookmarks Bar holds these nodes. */
function chromiumProfile(browser, ...children) {
  const file = path.join(browsers.chromiumBase(browser), "Default", "Bookmarks");
  assert.ok(file.startsWith(home + path.sep), `${file} is not under ${home}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "", children } } }));
  return file;
}

/**
 * An indexer per source of the selection now, its titles embedded, and each
 * page's text stored as one chunk, as a lease holder with no skip list left
 * it. Returns semanticSearch's context and a close().
 */
async function indexed(pages, dir) {
  const embedder = new FakeEmbedder();
  const made = new Map();
  for (const { source } of lib.readBookmarks().read) {
    const indexer = new Indexer({
      embedder,
      bookmarksFile: () => source.bookmarks,
      entries: () => lib.sourceBookmarks(source),
      dir,
    });
    made.set(source.bookmarks, { indexer });
    indexer.start();
    await indexer.idle();
    const store = IndexStore.open({ bookmarksFile: source.bookmarks, dir });
    try {
      store.addPendingPages();
      for (const { url: u } of store.pageStates()) {
        const text = pages[u];
        if (!text) continue;
        store.upsertPage({ url: u, status: "ok", fetched_at: Date.now(), content_hash: "h", text });
        store.replaceChunks(u, [text], "h");
        store.setChunkVector(u, 0, text, fakeVector(text));
      }
    } finally {
      store.close();
    }
  }
  return {
    ctx: (env) => ({ embedder, indexes: (source) => made.get(source.bookmarks), env }),
    close: () => {
      for (const { indexer } of made.values()) indexer.close();
    },
  };
}

/** The results whose page text matched: each one's URL and snippet. */
const pageHits = (data) => data.results.filter((r) => r.matched_on === "page").map((r) => [r.url, r.snippet]);

test("one browser: a skipped folder or domain keeps a page's text out of the answer; the rest still match", async () => {
  chromiumProfile(
    "chrome",
    { type: "folder", name: "Private", children: [url("Bank", BANK)] },
    // The same page outside the skipped folder: one bookmark in a skipped folder keeps it private, as the fetcher does.
    url("Statements", BANK),
    url("Recipes", FOOD),
  );
  browsers.setStartupOptions({ browser: ["chrome"] });
  const { ctx, close } = await indexed({ [BANK]: BANK_TEXT, [FOOD]: FOOD_TEXT }, tempDir("mnemos-semantic-skip-cache-"));
  try {
    const open = await semanticSearch(ctx({}), "overdraft mortgage");
    assert.ok(pageHits(open).some(([u, s]) => u === BANK && s.includes("Overdraft")), "no skip list: the page matches");

    for (const env of [
      { MNEMOS_SKIP_FOLDERS: "Private" },
      { MNEMOS_SKIP_DOMAINS: "bank.example" },
      { MNEMOS_SKIP_DOMAINS: "*.example" },
    ]) {
      const data = await semanticSearch(ctx(env), "overdraft mortgage");
      assert.deepEqual(pageHits(data), [], `${JSON.stringify(env)}: no page match`);
      assert.ok(!JSON.stringify(data).includes("Overdraft"), `${JSON.stringify(env)}: none of the page's text`);
    }

    // Another page, outside the skip list, still matches by its text.
    const food = await semanticSearch(ctx({ MNEMOS_SKIP_FOLDERS: "Private" }), "sourdough starter");
    assert.deepEqual(pageHits(food).map(([u]) => u), [FOOD]);

    // A keyword hit on the title is still returned, without the page.
    const bank = await semanticSearch(ctx({ MNEMOS_SKIP_FOLDERS: "Private" }), "bank");
    assert.ok(bank.results.some((r) => r.url === BANK && r.matched_on === "keyword" && r.snippet === undefined));
  } finally {
    close();
  }
});

test("several browsers: a skip folder naming a browser keeps its pages' text out, matched with the prefix results show", async () => {
  chromiumProfile("chrome", url("Bank", BANK));
  chromiumProfile("brave", url("Recipes", FOOD), url("Statements", BANK));
  browsers.setStartupOptions({ browser: ["chrome", "brave"] });
  const { ctx, close } = await indexed({ [BANK]: BANK_TEXT, [FOOD]: FOOD_TEXT }, tempDir("mnemos-semantic-skip-cache-"));
  try {
    const open = await semanticSearch(ctx({}), "overdraft mortgage");
    assert.ok(pageHits(open).some(([u]) => u === BANK), "no skip list: the page matches");

    // Chrome's copy is private; Brave's copy of the same page is its own index's, not skipped.
    const data = await semanticSearch(ctx({ MNEMOS_SKIP_FOLDERS: "Chrome" }), "overdraft mortgage");
    const hits = data.results.filter((r) => r.matched_on === "page");
    assert.ok(hits.length > 0, "Brave's copy still matches");
    for (const hit of hits) assert.match(hit.folder, /^Brave › /, "only Brave's bookmark matches on its page");

    const both = await semanticSearch(ctx({ MNEMOS_SKIP_FOLDERS: "Chrome,Brave" }), "overdraft mortgage");
    assert.deepEqual(pageHits(both), []);
    const food = await semanticSearch(ctx({ MNEMOS_SKIP_FOLDERS: "Chrome" }), "sourdough starter");
    assert.deepEqual(pageHits(food).map(([u]) => u), [FOOD]);
  } finally {
    close();
  }
});
