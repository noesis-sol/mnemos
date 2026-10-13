// semantic_search starts a model that has not started: after a restart every
// title is already embedded, so the indexer never calls the model, and the
// query has to. In process (dist/semantic.js), on the fixture indexed with
// the fake embedder, through an embedder that is "not_started" until its
// first embed() and then loads as the test says.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedderUnavailableError, FakeEmbedder } from "../dist/embedder.js";
import { Indexer } from "../dist/indexer.js";
import { QUERY_EMBED_TIMEOUT_MS, semanticSearch } from "../dist/semantic.js";
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

function entriesOf(file) {
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = file;
  try {
    return [...lib.allBookmarks()];
  } finally {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
  }
}

/** The fixture's titles embedded by the fake into a fresh cache, as a previous run left them. */
async function indexed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-model-start-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  fs.copyFileSync(FIXTURE, bookmarks);
  const indexer = new Indexer({
    embedder: new FakeEmbedder(),
    bookmarksFile: () => bookmarks,
    entries: () => entriesOf(bookmarks),
    dir: path.join(dir, "cache"),
  });
  indexer.start();
  await indexer.idle();
  return { bookmarks, indexer };
}

/**
 * A model that is "not_started" until embed() is first called, then "loading"
 * until `load` settles: ready when it resolves, unavailable when it rejects.
 */
function lazyModel(load) {
  const fake = new FakeEmbedder();
  let state = { state: "not_started" };
  let loading;
  const calls = [];
  return {
    calls,
    ...{ id: fake.id, revision: fake.revision, dim: fake.dim, relevance: fake.relevance },
    status: () => ({ ...state }),
    async embed(texts, kind) {
      calls.push(kind);
      if (!loading) {
        state = { state: "loading" };
        loading = load().then(
          () => {
            state = { state: "ready" };
          },
          (err) => {
            state = { state: "unavailable", reason: err.message };
            throw new EmbedderUnavailableError(err.message);
          },
        );
      }
      await loading;
      return fake.embed(texts, kind);
    },
  };
}

async function searchIn(bookmarks, ctx, query) {
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = bookmarks;
  try {
    return await semanticSearch({ ...ctx, env: {} }, query);
  } finally {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
  }
}

test("model start: a query starts a model that has not started, and is answered semantically once it loads", async () => {
  const { bookmarks, indexer } = await indexed();
  const embedder = lazyModel(async () => {});
  try {
    const data = await searchIn(bookmarks, { embedder, indexer }, "poems");
    assert.deepEqual(embedder.calls, ["query"]);
    assert.equal(data.status.search, "semantic");
    assert.equal(data.status.embedder, "ready");
    assert.equal(data.status.note, undefined);
    assert.equal(data.results[0].title, "Καβάφης — Ποιήματα");
  } finally {
    indexer.close();
  }
});

test("model start: a model that cannot load gives keyword results and says why", async () => {
  const { bookmarks, indexer } = await indexed();
  const embedder = lazyModel(async () => {
    throw new Error("no onnxruntime here");
  });
  try {
    const data = await searchIn(bookmarks, { embedder, indexer }, "openai");
    assert.equal(data.status.search, "keyword");
    assert.equal(data.status.embedder, "unavailable");
    assert.match(data.status.note, /the embedding model is unavailable: no onnxruntime here/);
    assert.deepEqual(
      data.results.map((r) => r.title),
      ["OpenAI"],
    );
  } finally {
    indexer.close();
  }
});

test("model start: a model still loading when the query gives up keeps loading for the next query", { timeout: QUERY_EMBED_TIMEOUT_MS + 10_000 }, async () => {
  const { bookmarks, indexer } = await indexed();
  let release;
  const embedder = lazyModel(() => new Promise((resolve) => (release = resolve)));
  try {
    const first = await searchIn(bookmarks, { embedder, indexer }, "openai");
    assert.equal(first.status.search, "keyword");
    assert.equal(first.status.embedder, "loading");
    assert.match(first.status.note, /the embedding model is still loading/);

    release();
    await new Promise((resolve) => setImmediate(resolve)); // the load settles
    const second = await searchIn(bookmarks, { embedder, indexer }, "poems");
    assert.equal(second.status.search, "semantic");
    assert.equal(second.status.embedder, "ready");
  } finally {
    indexer.close();
  }
});
