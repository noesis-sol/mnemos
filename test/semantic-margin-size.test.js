// semantic_search's margin over the median title scales with the library's
// size when the relevance says what size it was calibrated on: the best of N
// unrelated titles stands about σ·√(2 ln N) above the median, so a small
// library's margin is smaller. relevanceMargin directly, and in process
// (dist/semantic.js) on the fixture indexed with the fake embedder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeEmbedder, MODEL_RELEVANCE } from "../dist/embedder.js";
import { Indexer } from "../dist/indexer.js";
import { relevanceMargin, semanticSearch } from "../dist/semantic.js";
import * as lib from "../dist/lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

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

const close = (a, b) => Math.abs(a - b) < 1e-12;

test("margin: unscaled without marginTitles", () => {
  const relevance = { floor: 0.5, margin: 0.1, window: 1 };
  for (const titles of [0, 1, 31, 2300, 100_000]) assert.equal(relevanceMargin(relevance, titles), 0.1);
});

test("margin: the margin as calibrated at marginTitles, √(ln N / ln marginTitles) of it elsewhere", () => {
  const relevance = { floor: 0.5, margin: 0.1, window: 1, marginTitles: 1000 };
  assert.ok(close(relevanceMargin(relevance, 1000), 0.1));
  assert.ok(close(relevanceMargin(relevance, 10), 0.1 * Math.sqrt(1 / 3)));
  assert.ok(close(relevanceMargin(relevance, 1_000_000), 0.1 * Math.sqrt(2)));
  // One title (or none) has no spread to stand out from: the floor and window decide.
  assert.equal(relevanceMargin(relevance, 1), 0);
  assert.equal(relevanceMargin(relevance, 0), 0);
  // Grows with the library.
  const sizes = [2, 10, 31, 300, 1000, 2300, 10_000];
  const margins = sizes.map((n) => relevanceMargin(relevance, n));
  assert.deepEqual([...margins].sort((a, b) => a - b), margins);
});

test("margin: the real model's margin is 0.065 at 2,300 titles and about 0.043 at 31", () => {
  assert.equal(MODEL_RELEVANCE.marginTitles, 2300);
  assert.ok(close(relevanceMargin(MODEL_RELEVANCE, 2300), 0.065));
  assert.ok(Math.abs(relevanceMargin(MODEL_RELEVANCE, 31) - 0.0433) < 5e-4);
});

test("margin: semantic_search keeps what the scaled margin keeps", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-margin-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  fs.copyFileSync(FIXTURE, bookmarks);
  const fake = new FakeEmbedder();
  const entries = () => withBookmarks(bookmarks, () => [...lib.allBookmarks()]);
  const titles = entries().length;
  const indexer = new Indexer({ embedder: fake, bookmarksFile: () => bookmarks, entries, dir: path.join(dir, "cache") });
  indexer.start();
  await indexer.idle();
  // OpenAI scores about 0.44 and Attention about 0.16; the median title, 0.
  const kept = async (relevance) => {
    const embedder = {
      ...{ id: fake.id, revision: fake.revision, dim: fake.dim, relevance },
      status: () => fake.status(),
      embed: (texts, kind) => fake.embed(texts, kind),
    };
    const data = await withBookmarks(bookmarks, () => semanticSearch({ embedder, indexer, env: {} }, "arxiv openai models"));
    return data.results.map((r) => r.title);
  };
  try {
    assert.deepEqual(await kept({ floor: 0.01, margin: 0.3, window: 1 }), ["OpenAI"], "precondition: 0.3 cuts Attention");
    assert.deepEqual(await kept({ floor: 0.01, margin: 0.3, window: 1, marginTitles: titles }), ["OpenAI"], "at its size, as is");
    // A margin calibrated on titles⁹ is a third as large here: 0.1.
    assert.deepEqual(
      await kept({ floor: 0.01, margin: 0.3, window: 1, marginTitles: titles ** 9 }),
      ["OpenAI", "Attention is all you need"],
    );
  } finally {
    indexer.close();
  }
});
