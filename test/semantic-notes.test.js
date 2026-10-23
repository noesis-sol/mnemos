// semantic_search's status note: keyword hits alone while the index cannot be
// built or has not opened yet, and the titles still being embedded while the
// model is ready. In process (dist/semantic.js), on the fixture, with the fake
// embedder; a gated fake holds the indexer's embedding back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer } from "../dist/indexer.js";
import { semanticSearch } from "../dist/semantic.js";
import * as lib from "../dist/lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");
/** Long enough that a search's checkForChanges() schedules no run before the test closes the indexer. */
const NO_RERUN_MS = 60_000;

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

function withBookmarks(file, fn) {
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = file;
  const restore = () => {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

/** A fresh directory with a copy of the fixture as its Bookmarks file. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-semantic-notes-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  fs.copyFileSync(FIXTURE, bookmarks);
  return { dir, bookmarks, cache: path.join(dir, "cache") };
}

function indexerOn(s, { embedder = new FakeEmbedder(), dir = s.cache, debounceMs = NO_RERUN_MS } = {}) {
  return new Indexer({
    embedder,
    bookmarksFile: () => s.bookmarks,
    entries: () => withBookmarks(s.bookmarks, () => [...lib.allBookmarks()]),
    dir,
    debounceMs,
  });
}

function search(s, ctx, query) {
  return withBookmarks(s.bookmarks, () => semanticSearch({ ...ctx, env: {} }, query));
}

/** Runs `fn` with console.error kept quiet: a failed run reports itself there. */
async function quietly(fn) {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
}

async function until(condition, what) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("semantic notes: an index that cannot be built gives keyword hits and says why", async () => {
  const s = scratch();
  // The cache directory is a file: the index cannot be created under it.
  const blocker = path.join(s.dir, "not-a-directory");
  fs.writeFileSync(blocker, "");
  const embedder = new FakeEmbedder();
  const indexer = indexerOn(s, { embedder, dir: path.join(blocker, "cache") });
  try {
    await quietly(async () => {
      indexer.start();
      await indexer.idle();
    });
    const { state, error } = indexer.status();
    assert.equal(state, "failed");
    assert.ok(error, "the run's error is kept");

    const data = await search(s, { embedder, indexer }, "watercolor basics");
    assert.equal(data.status.search, "keyword");
    assert.equal(data.status.indexing, "failed");
    assert.equal(data.status.embedder, "ready");
    assert.equal(
      data.status.note,
      `Keyword matches only (as search_bookmarks): the index could not be built: ${error}. ` +
        "Retry later for semantic results.",
    );
    assert.deepEqual(
      data.results.map((r) => [r.title, r.matched_on, r.score]),
      [["Watercolor basics", "keyword", null]],
    );
  } finally {
    indexer.close();
  }
});

test("semantic notes: a query before the index has opened gives keyword hits and says to retry later", async () => {
  const s = scratch();
  const embedder = new FakeEmbedder();
  const indexer = indexerOn(s, { embedder }); // never started: no run has opened the index
  try {
    const data = await search(s, { embedder, indexer }, "openai");
    assert.equal(data.status.search, "keyword");
    assert.equal(data.status.indexing, "not started");
    assert.equal(data.status.embedder, "ready");
    assert.equal(
      data.status.note,
      "Keyword matches only (as search_bookmarks): the index is not open yet. Retry later for semantic results.",
    );
    assert.deepEqual(
      data.results.map((r) => [r.title, r.matched_on]),
      [["OpenAI", "keyword"]],
    );
  } finally {
    indexer.close();
  }
});

test("semantic notes: titles still being embedded with the model ready, then no note once all are", async () => {
  const s = scratch();
  // A previous run embedded the fixture's titles.
  const first = indexerOn(s);
  first.start();
  await first.idle();
  const { titles_total: fixtureCount } = first.status();
  first.close();

  // Three bookmarks added since, whose titles wait for the gate.
  const added = [
    { type: "url", name: "Zeppelin history", url: "https://example.org/zeppelin" },
    { type: "url", name: "Origami cranes", url: "https://example.org/origami" },
    { type: "url", name: "Sourdough starter", url: "https://example.org/sourdough" },
  ];
  const json = JSON.parse(fs.readFileSync(s.bookmarks, "utf8"));
  json.roots.bookmark_bar.children.push(...added);
  fs.writeFileSync(s.bookmarks, JSON.stringify(json, null, 2));

  const gate = path.join(s.dir, "gate");
  const indexer = indexerOn(s, { embedder: new FakeEmbedder({ gate }), debounceMs: 0 });
  const embedder = new FakeEmbedder(); // the query's: ready, never gated
  try {
    indexer.start();
    await until(() => indexer.status().titles_total === fixtureCount + 3, "the run to count the titles");
    assert.deepEqual(indexer.status(), {
      state: "indexing",
      titles_done: fixtureCount,
      titles_total: fixtureCount + 3,
    });

    const data = await search(s, { embedder, indexer }, "poems");
    assert.equal(data.status.search, "semantic");
    assert.equal(data.status.indexing, "indexing");
    assert.equal(data.status.embedder, "ready");
    assert.match(data.status.progress, new RegExp(`^titles ${fixtureCount}/${fixtureCount + 3} · `));
    assert.equal(
      data.status.note,
      `Bookmark titles are still being embedded (${fixtureCount} of ${fixtureCount + 3}); ` +
        "the rest are found only by exact words for now.",
    );
    assert.equal(data.results[0].title, "Καβάφης — Ποιήματα");
    assert.equal(data.results[0].matched_on, "title");

    // A title not embedded yet is found by its exact words, unscored.
    const zeppelin = await search(s, { embedder, indexer }, "zeppelin");
    assert.deepEqual(
      zeppelin.results.map((r) => [r.title, r.matched_on, r.score]),
      [["Zeppelin history", "keyword", null]],
    );

    fs.writeFileSync(gate, "");
    await indexer.idle();
    assert.deepEqual(indexer.status(), {
      state: "ready",
      titles_done: fixtureCount + 3,
      titles_total: fixtureCount + 3,
    });

    const done = await search(s, { embedder, indexer }, "poems");
    assert.equal(done.status.search, "semantic");
    assert.equal(done.status.indexing, "ready");
    assert.match(done.status.progress, new RegExp(`^titles ${fixtureCount + 3}/${fixtureCount + 3} · `));
    assert.equal(done.status.note, undefined);
    assert.equal("note" in done.status, false);
    assert.equal(done.results[0].title, "Καβάφης — Ποιήματα");
  } finally {
    indexer.close();
  }
});
