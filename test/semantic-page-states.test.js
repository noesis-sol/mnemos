// semantic_search's status.page_states: how many pages are in each fetch
// state, read from the index the indexer has open (in process, dist/semantic.js,
// with the fake embedder). Empty before the index is open; then one count per
// state that has pages, kept current as the fetcher's store changes them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { semanticSearch } from "../dist/semantic.js";
import * as lib from "../dist/lib.js";

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

const URLS = ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d"];

/** semanticSearch with CHROME_BOOKMARKS_PATH pointing at `file` for the call. */
async function searchIn(file, ctx, query) {
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = file;
  try {
    return await semanticSearch(ctx, query);
  } finally {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
  }
}

test("semantic search: status.page_states counts the pages in each fetch state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-page-states-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  const children = URLS.map((url, i) => ({ type: "url", name: `Page ${i}`, url }));
  fs.writeFileSync(bookmarks, JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "Bar", children } } }));
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = bookmarks;
  const entries = [...lib.allBookmarks()];
  if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
  else process.env.CHROME_BOOKMARKS_PATH = saved;

  const embedder = new FakeEmbedder();
  const indexer = new Indexer({ embedder, bookmarksFile: () => bookmarks, entries: () => entries, dir });
  const ctx = { embedder, indexer, env: {} };
  try {
    assert.deepEqual(indexer.pageCounts(), {}, "no index open yet");
    indexer.start();
    await indexer.idle();
    assert.deepEqual((await searchIn(bookmarks, ctx, "page")).status.page_states, {}, "no page rows yet");

    // The fetcher's side: its own store on the same file.
    const store = IndexStore.open({ bookmarksFile: bookmarks, dir });
    try {
      store.addPendingPages();
      assert.deepEqual((await searchIn(bookmarks, ctx, "page")).status.page_states, { pending: 4 });
      store.upsertPage({ url: URLS[0], status: "ok", content_hash: "x", text: "Some text." });
      store.upsertPage({ url: URLS[1], status: "needs_login", reason: "password field", text: null });
      store.upsertPage({ url: URLS[2], status: "skipped", reason: "token-like", text: null });
    } finally {
      store.close();
    }
    const { status } = await searchIn(bookmarks, ctx, "page");
    assert.deepEqual(status.page_states, { ok: 1, needs_login: 1, skipped: 1, pending: 1 });
  } finally {
    indexer.close();
  }
});
