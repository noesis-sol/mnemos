// Bookmark titles embedded in the background. Over MCP (the built server,
// spawned and driven with the SDK's client, MNEMOS_EMBEDDER=fake in a
// temporary MNEMOS_CACHE_DIR, on a copy of the fixture): the handshake and
// tool calls do not wait for indexing, every bookmark gets a vector, a restart
// embeds nothing, and an edited file re-embeds only what changed. In process
// (dist/indexer.js): checkForChanges() and its debounce, and errors kept in
// status() rather than thrown.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { indexFile } from "../dist/index-store.js";
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer, bookmarkRows, embeddingText } from "../dist/indexer.js";
import * as lib from "../dist/lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A copy of the fixture, a cache directory, and the fake embedder's gate and log files. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-title-index-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  fs.copyFileSync(FIXTURE, bookmarks);
  return { dir, bookmarks, cache: path.join(dir, "cache"), gate: path.join(dir, "gate"), log: path.join(dir, "embedded.log") };
}

async function startServer(s) {
  const client = new Client({ name: "mnemos-title-index", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: s.bookmarks,
        MNEMOS_CACHE_DIR: s.cache,
        MNEMOS_EMBEDDER: "fake",
        MNEMOS_FAKE_EMBED_GATE: s.gate,
        MNEMOS_FAKE_EMBED_LOG: s.log,
      },
      stderr: "ignore",
    }),
  );
  return client;
}

/** What the index holds, or null while it is not there yet. */
function readIndex(s) {
  const file = indexFile(s.bookmarks, s.cache);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db.prepare("SELECT guid, url, title, vector FROM bookmarks ORDER BY guid").all();
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'titles_indexed_at'").get();
    return { rows, indexedAt: meta ? Number(meta.value) : undefined };
  } catch {
    return null; // the server is still creating it
  } finally {
    db.close();
  }
}

/** The texts the fake embedder embedded, in order. */
function embedded(s) {
  if (!fs.existsSync(s.log)) return [];
  return fs.readFileSync(s.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function until(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The index once a run that started at or after `since` has completed. */
function indexedSince(s, since) {
  return until(() => {
    const index = readIndex(s);
    return index?.indexedAt !== undefined && index.indexedAt >= since ? index : null;
  }, "the index run to complete");
}

/** The bookmarks of `file`, as lib reads them. */
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

function textOf(entry) {
  return embeddingText({ title: entry.node.name ?? "", folder_path: entry.folder, url: entry.node.url ?? "" });
}

// --- over MCP ----------------------------------------------------------------

const served = scratch();
const fixtureCount = entriesOf(FIXTURE).length;

test("e2e: initialize and tool calls return while a slow embedder holds indexing up", async () => {
  // The gate file does not exist yet, so the fake embedder waits in embed().
  const client = await startServer(served);
  try {
    const result = await client.callTool({ name: "search_bookmarks", arguments: { query: "openai" } });
    assert.equal(JSON.parse(result.content[0].text).total_matches, 1);
    const before = readIndex(served);
    if (before) {
      assert.equal(before.indexedAt, undefined, "no run has completed");
      assert.equal(before.rows.filter((r) => r.vector).length, 0, "no vector stored yet");
    }
    assert.deepEqual(embedded(served), [], "nothing embedded yet");

    fs.writeFileSync(served.gate, "");
    const index = await indexedSince(served, 0);
    assert.equal(index.rows.length, fixtureCount, "one row per fixture bookmark");
    for (const row of index.rows) assert.equal(row.vector?.byteLength, 384 * 4, `${row.title} has a vector`);
    assert.deepEqual(
      [...embedded(served)].sort(),
      entriesOf(served.bookmarks).map(textOf).sort(),
      "each bookmark's text embedded once",
    );
  } finally {
    await client.close();
  }
});

test("e2e: a second start embeds nothing", async () => {
  const before = embedded(served).length;
  const since = Date.now();
  const client = await startServer(served);
  try {
    const index = await indexedSince(served, since);
    assert.equal(index.rows.length, fixtureCount);
    assert.equal(embedded(served).length, before, "no text embedded again");
  } finally {
    await client.close();
  }
});

test("e2e: an added, a renamed and a deleted bookmark re-embed exactly the changed rows", async () => {
  const data = JSON.parse(fs.readFileSync(served.bookmarks, "utf8"));
  const bar = data.roots.bookmark_bar.children;
  const ai = bar.find((n) => n.name === "AI");
  ai.children.find((n) => n.name === "OpenAI").name = "OpenAI research";
  bar.splice(bar.findIndex((n) => n.name === "Gmail"), 1);
  ai.children.push({ type: "url", name: "LiveKit Agents", url: "https://github.com/livekit/agents" });
  fs.writeFileSync(served.bookmarks, JSON.stringify(data));

  const before = embedded(served).length;
  const since = Date.now();
  const client = await startServer(served);
  try {
    const index = await indexedSince(served, since);
    assert.deepEqual(embedded(served).slice(before).sort(), [
      "LiveKit Agents\nBookmarks Bar › AI\ngithub livekit agents",
      "OpenAI research\nBookmarks Bar › AI\nopenai",
    ]);
    assert.equal(index.rows.length, fixtureCount, "one added, one deleted");
    assert.ok(!index.rows.some((r) => r.url === "https://mail.google.com/"), "the deleted bookmark's row is gone");
    for (const row of index.rows) assert.ok(row.vector, `${row.title} has a vector`);
  } finally {
    await client.close();
  }
});

// --- in process --------------------------------------------------------------

/** The fake embedder, counting what it embeds; `fail` makes it reject. */
function countingEmbedder() {
  const fake = new FakeEmbedder();
  const embedder = {
    id: fake.id,
    revision: fake.revision,
    dim: fake.dim,
    texts: [],
    fail: undefined,
    status: () => fake.status(),
    async embed(texts, kind) {
      if (embedder.fail) throw new Error(embedder.fail);
      embedder.texts.push(...texts);
      return fake.embed(texts, kind);
    },
  };
  return embedder;
}

function inProcessIndexer(s, embedder, options = {}) {
  let reads = 0;
  const indexer = new Indexer({
    embedder,
    bookmarksFile: () => s.bookmarks,
    entries: () => {
      reads++;
      return entriesOf(s.bookmarks);
    },
    dir: s.cache,
    debounceMs: 30,
    ...options,
  });
  return { indexer, reads: () => reads };
}

/** Rewrites the file with `edit` applied, and moves its mtime on so the change is seen. */
function editBookmarks(file, edit) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(data);
  fs.writeFileSync(file, JSON.stringify(data));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(file, later, later);
}

test("indexer: progress counts the titles, and start() leaves the caller's turn alone", async () => {
  const s = scratch();
  const embedder = countingEmbedder();
  const { indexer, reads } = inProcessIndexer(s, embedder);
  assert.deepEqual(indexer.status(), { state: "not_started", titles_done: 0, titles_total: 0 });
  indexer.start();
  assert.equal(reads(), 0, "nothing read on the caller's turn");
  await indexer.idle();
  assert.deepEqual(indexer.status(), { state: "ready", titles_done: fixtureCount, titles_total: fixtureCount });
  assert.deepEqual(indexer.progress(), { titles_done: fixtureCount, titles_total: fixtureCount });
  assert.equal(embedder.texts.length, fixtureCount);
  indexer.close();
});

test("indexer: checkForChanges re-indexes once, after the debounce, only when the file changed", async () => {
  const s = scratch();
  const embedder = countingEmbedder();
  const { indexer, reads } = inProcessIndexer(s, embedder);
  indexer.start();
  await indexer.idle();
  assert.equal(reads(), 1);

  for (let i = 0; i < 3; i++) indexer.checkForChanges();
  await indexer.idle();
  assert.equal(reads(), 1, "an unchanged file is not read again");

  editBookmarks(s.bookmarks, (data) => {
    data.roots.bookmark_bar.children.find((n) => n.name === "Gmail").name = "Mail";
  });
  for (let i = 0; i < 3; i++) indexer.checkForChanges();
  assert.equal(reads(), 1, "debounced: not yet");
  await indexer.idle();
  assert.equal(reads(), 2, "three calls, one run");
  assert.deepEqual(embedder.texts.slice(fixtureCount), ["Mail\nBookmarks Bar\nmail google"]);
  assert.equal(indexer.status().state, "ready");
  indexer.close();
});

test("indexer: errors land in status(), never in the caller, and the next check retries", async () => {
  const s = scratch();
  const embedder = countingEmbedder();
  embedder.fail = "model went missing";
  const { indexer, reads } = inProcessIndexer(s, embedder);
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    indexer.start();
    await indexer.idle();
    assert.equal(indexer.status().state, "failed");
    assert.equal(indexer.status().error, "model went missing");
    assert.equal(indexer.status().titles_total, fixtureCount);
    assert.equal(indexer.status().titles_done, 0);

    // The file is unchanged, but the last run did not complete.
    indexer.checkForChanges();
    await indexer.idle();
    assert.equal(reads(), 2);
    assert.equal(logged.length, 1, "the same error is logged once");
    assert.match(logged[0], /model went missing/);

    embedder.fail = undefined;
    indexer.checkForChanges();
    await indexer.idle();
    assert.deepEqual(indexer.status(), { state: "ready", titles_done: fixtureCount, titles_total: fixtureCount });

    fs.rmSync(s.bookmarks);
    indexer.checkForChanges();
    await indexer.idle();
    assert.equal(indexer.status().state, "failed");
    assert.match(indexer.status().error, /No bookmarks file/);
  } finally {
    console.error = consoleError;
    indexer.close();
  }
});

test("indexer: an unusable cache directory is a failed status, not a throw", async () => {
  const s = scratch();
  fs.writeFileSync(s.cache, "a file where the directory should be");
  const { indexer } = inProcessIndexer(s, countingEmbedder());
  const consoleError = console.error;
  console.error = () => {};
  try {
    indexer.start();
    await indexer.idle();
    assert.equal(indexer.status().state, "failed");
    assert.ok(indexer.status().error);
  } finally {
    console.error = consoleError;
    indexer.close();
  }
});

test("indexer: a new embedder model re-embeds every title", async () => {
  const s = scratch();
  const first = countingEmbedder();
  const one = inProcessIndexer(s, first).indexer;
  one.start();
  await one.idle();
  one.close();

  const second = countingEmbedder();
  second.revision = "2";
  const two = inProcessIndexer(s, second).indexer;
  two.start();
  await two.idle();
  assert.equal(second.texts.length, fixtureCount);
  two.close();
});

// --- row keys ----------------------------------------------------------------

test("bookmark rows: a Chromium guid is the key; without one, folder, URL and copy are", () => {
  const node = (name, url, guid) => ({ type: "url", name, url, ...(guid ? { guid } : {}) });
  const rows = bookmarkRows([
    { folder: "Bar", node: node("A", "https://a.example/", "guid-a") },
    { folder: "Bar", node: node("B", "https://b.example/") },
    { folder: "Bar", node: node("B again", "https://b.example/") },
    { folder: "Other", node: node("B", "https://b.example/") },
  ]);
  assert.equal(rows[0].guid, "guid-a");
  assert.equal(new Set(rows.map((r) => r.guid)).size, 4, "duplicates get keys of their own");
  const retitled = bookmarkRows([{ folder: "Bar", node: node("B renamed", "https://b.example/") }]);
  assert.equal(retitled[0].guid, rows[1].guid, "a retitle keeps the key");
  assert.notEqual(retitled[0].text_hash, rows[1].text_hash, "and changes the text hash");
  assert.equal(rows[1].folder_path, "Bar");
});
