// An index file that goes bad while a store has it open, in process: an
// Indexer (the fake embedder, on a copy of the fixture) and a Fetcher (a fake
// fetch), each in a temporary MNEMOS_CACHE_DIR. The file's header is
// overwritten after a first complete run; the open store then fails with
// "file is not a database", which is reported, and the next run (or the
// fetcher's next heartbeat) reopens the store, which moves the bad file aside
// and starts a new one. semantic_search meanwhile answers with keyword hits.
//
// Overwriting the header alone is not seen by an open connection: in WAL mode
// it keeps its pages cached, and the latest ones live in the WAL. So another
// connection first checkpoints the WAL into the file and truncates it, which
// also makes the open one drop its cache and read the file again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore, indexFile } from "../dist/index-store.js";
import { Fetcher } from "../dist/fetcher.js";
import { Indexer } from "../dist/indexer.js";
import { semanticSearch } from "../dist/semantic.js";
import * as lib from "../dist/lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");
const NOT_A_DATABASE = /file is not a database/;

const dirs = [];
// Every test closes its indexers and fetchers first; a directory that will not go is let be.
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Checkpoints the WAL into the file from another connection, then overwrites the file's header. */
function corrupt(file) {
  const other = new DatabaseSync(file);
  try {
    other.exec("PRAGMA busy_timeout = 5000");
    other.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    other.close();
  }
  const fd = fs.openSync(file, "r+");
  try {
    fs.writeSync(fd, Buffer.alloc(100, 0xab), 0, 100, 0);
  } finally {
    fs.closeSync(fd);
  }
}

/** The files the bad index was moved aside to. */
function movedAside(dir) {
  return fs.readdirSync(dir).filter((name) => /\.sqlite\.corrupt-\d+$/.test(name));
}

/** Errors the code under test writes to stderr while `fn` runs. */
async function capturingErrors(fn) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    return await fn(errors);
  } finally {
    console.error = original;
  }
}

// --- the title indexer -------------------------------------------------------

/** A copy of the fixture and a cache directory. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-corrupt-open-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  fs.copyFileSync(FIXTURE, bookmarks);
  return { bookmarks, cache: path.join(dir, "cache") };
}

/** The bookmarks of `file`, as lib reads them. */
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

const entriesOf = (file) => withBookmarks(file, () => [...lib.allBookmarks()]);
const fixtureCount = entriesOf(FIXTURE).length;

/** The fake embedder, keeping the passages (titles) it embeds; queries are not kept. */
function countingEmbedder() {
  const fake = new FakeEmbedder();
  return {
    id: fake.id,
    revision: fake.revision,
    dim: fake.dim,
    relevance: fake.relevance,
    texts: [],
    status: () => fake.status(),
    async embed(texts, kind) {
      if (kind === "passage") this.texts.push(...texts);
      return fake.embed(texts, kind);
    },
  };
}

function indexerOn(s, embedder, options = {}) {
  return new Indexer({
    embedder,
    bookmarksFile: () => s.bookmarks,
    entries: () => entriesOf(s.bookmarks),
    dir: s.cache,
    debounceMs: 30,
    ...options,
  });
}

/** Moves the Bookmarks file's mtime on, as an edit would, so a check or the poll sees a change. */
function touch(file) {
  const later = new Date(Date.now() + 60_000 * (touch.count = (touch.count ?? 0) + 1));
  fs.utimesSync(file, later, later);
}

/** Vectors in the index file, read with a plain connection (an IndexStore would rebuild a bad file). */
function storedVectors(s) {
  const db = new DatabaseSync(indexFile(s.bookmarks, s.cache));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE vector IS NOT NULL").get().n;
  } finally {
    db.close();
  }
}

test("indexer: a store corrupted while open fails the next run, and the run after rebuilds it, semantic_search keyword-only meanwhile", async () => {
  const s = scratch();
  const embedder = countingEmbedder();
  const indexer = indexerOn(s, embedder);
  const search = (query) => withBookmarks(s.bookmarks, () => semanticSearch({ embedder, indexer, env: {} }, query));
  await capturingErrors(async (errors) => {
    try {
      indexer.start();
      await indexer.idle();
      assert.deepEqual(indexer.status(), { state: "ready", titles_done: fixtureCount, titles_total: fixtureCount });
      assert.equal(embedder.texts.length, fixtureCount);
      assert.equal((await search("aquarelle")).results[0].matched_on, "title", "semantic before the damage");

      corrupt(indexFile(s.bookmarks, s.cache));

      // The store is still open: scoring the query against it fails, and the answer is the keyword hits.
      let data = await search("watercolor basics");
      assert.match(data.status.note, /^Keyword matches only \(as search_bookmarks\): file is not a database\./);
      assert.deepEqual(
        data.results.map((r) => [r.title, r.matched_on]),
        [["Watercolor basics", "keyword"]],
      );

      // The next run meets the bad file, reports it, and closes the store; it moves nothing aside yet.
      touch(s.bookmarks);
      indexer.checkForChanges();
      await indexer.idle();
      assert.equal(indexer.status().state, "failed");
      assert.match(indexer.status().error, NOT_A_DATABASE);
      assert.ok(errors.some((e) => /^mnemos: indexing bookmarks failed: file is not a database/.test(e)), errors.join("\n"));
      assert.equal(embedder.texts.length, fixtureCount, "nothing embedded by the failed run");
      assert.deepEqual(movedAside(s.cache), []);

      // While it is closed: keyword hits again, with the failure as the reason. This search's
      // checkForChanges() schedules the retry of the failed run, after the debounce.
      data = await search("watercolor basics");
      assert.match(data.status.note, /^Keyword matches only \(as search_bookmarks\): the index could not be built: file is not a database\./);
      assert.deepEqual(
        data.results.map((r) => [r.title, r.matched_on]),
        [["Watercolor basics", "keyword"]],
      );

      // The next run reopens the store: the bad file is moved aside, and every title embedded again.
      indexer.checkForChanges();
      await indexer.idle();
      assert.deepEqual(indexer.status(), { state: "ready", titles_done: fixtureCount, titles_total: fixtureCount });
      assert.equal(movedAside(s.cache).length, 1);
      assert.equal(embedder.texts.length, 2 * fixtureCount);
      assert.deepEqual(embedder.texts.slice(fixtureCount).sort(), embedder.texts.slice(0, fixtureCount).sort());
      assert.equal(storedVectors(s), fixtureCount);
      data = await search("aquarelle");
      assert.equal(data.status.note, undefined);
      assert.equal(data.results[0].title, "Watercolor basics");
      assert.equal(data.results[0].matched_on, "title");
    } finally {
      indexer.close();
    }
  });
});

test("indexer: the poll's run fails on a store corrupted while open, and its run after the next edit rebuilds it", async () => {
  const s = scratch();
  const embedder = countingEmbedder();
  const indexer = indexerOn(s, embedder, { pollMs: 10 });
  await capturingErrors(async () => {
    try {
      indexer.start();
      await indexer.idle();
      assert.equal(indexer.status().state, "ready");
      assert.equal(embedder.texts.length, fixtureCount);

      corrupt(indexFile(s.bookmarks, s.cache));
      touch(s.bookmarks);
      await until(() => indexer.status().state === "failed", "the poll's run to fail");
      await indexer.idle();
      assert.match(indexer.status().error, NOT_A_DATABASE);
      assert.deepEqual(movedAside(s.cache), []);

      touch(s.bookmarks);
      await until(() => indexer.status().state === "ready", "the poll's run to rebuild the index");
      await indexer.idle();
      assert.equal(movedAside(s.cache).length, 1);
      assert.equal(embedder.texts.length, 2 * fixtureCount);
      assert.equal(storedVectors(s), fixtureCount);
    } finally {
      indexer.close();
    }
  });
});

// --- the page fetcher --------------------------------------------------------

function article(word) {
  const paragraph = (n) =>
    `<p>Paragraph ${n} about the ${word}: a long and careful explanation of how the ${word} lives, ` +
    `what it eats, where it sleeps and why people who bookmark pages about it keep coming back to read more.</p>`;
  return `<!doctype html><html><head><title>${word}</title></head><body><article><h1>${word}</h1>${[1, 2, 3, 4, 5, 6]
    .map(paragraph)
    .join("")}</article></body></html>`;
}

function html(url, body) {
  return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: body };
}

test("fetcher: a store corrupted while open fails the fetcher, whose next heartbeat reopens it and fetches on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-corrupt-fetch-"));
  dirs.push(dir);
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const urls = ["https://a.example/", "https://b.example/", "https://c.example/"];
  const rows = urls.map((url, i) => ({ guid: `g-${i}`, url, title: `Title of ${url}`, folder_path: "Bar", text_hash: `h-${i}` }));
  // The bookmarks' rows, as the title indexer stores them; the fetcher adds their pages.
  const syncBookmarks = () => {
    const store = IndexStore.open({ bookmarksFile, dir });
    try {
      store.syncBookmarks(rows);
    } finally {
      store.close();
    }
  };
  /** The pages' states, read with a plain connection (an IndexStore would rebuild a bad file). */
  const states = () => {
    const db = new DatabaseSync(indexFile(bookmarksFile, dir));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return Object.fromEntries(db.prepare("SELECT url, status FROM pages").all().map((r) => [r.url, r.status]));
    } finally {
      db.close();
    }
  };
  const allOk = () => urls.every((url) => states()[url] === "ok");
  syncBookmarks();

  const calls = [];
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => bookmarksFile,
    entries: () => urls.map((url) => ({ folder: "Bar", node: { type: "url", name: `Title of ${url}`, url } })),
    dir,
    fetch: async (url) => {
      calls.push(url);
      return html(url, article("aardvark"));
    },
    domainGapMs: 0,
    heartbeatMs: 50,
    idlePollMs: 10,
  });
  await capturingErrors(async (errors) => {
    try {
      fetcher.start();
      await until(() => allOk() && fetcher.status().state === "idle", "the first fetches");
      assert.equal(fetcher.isHolder(), true);
      assert.deepEqual([...calls].sort(), urls);

      corrupt(indexFile(bookmarksFile, dir));

      // The failure is reported, then a heartbeat reopens the store, moving the bad file aside, and takes the lease again.
      await until(() => errors.some((e) => /^mnemos: fetching pages failed: file is not a database/.test(e)), "the failure");
      await until(() => movedAside(dir).length === 1 && fetcher.isHolder(), "a heartbeat to reopen the store");
      assert.notEqual(fetcher.status().state, "failed");

      // It carries on: the new index's bookmarks are fetched again.
      syncBookmarks();
      await until(() => allOk() && fetcher.status().state === "idle", "the fetches into the new index");
      assert.equal(fetcher.status().state, "idle");
      assert.equal(calls.length, 2 * urls.length);
      assert.deepEqual([...calls.slice(urls.length)].sort(), urls);
    } finally {
      fetcher.stop();
      await fetcher.idle();
    }
  });
});
