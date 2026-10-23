// Stopping the indexing at shutdown. The client closing stdin is how an MCP
// server is told to exit, and the server then stops its indexers too, not
// only its fetchers: it exits at the end of the embed() call in progress
// rather than once every title is embedded. Over MCP (the built server,
// spawned with a raw pipe, MNEMOS_EMBEDDER=fake with a delay that, like a
// model's run, keeps the process alive), in process (dist/indexer.js: a
// closed indexer starts no run again), and for the runtime's npm install
// (dist/runtime.js: stopInstalls() kills it, with a stand-in npm that never
// finishes).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer, TITLE_BATCH } from "../dist/indexer.js";
import { RuntimeInstallError, TRANSFORMERS, loadTransformers, runtimeDir, stopInstalls } from "../dist/runtime.js";

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

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-shutdown-"));
  dirs.push(dir);
  return dir;
}

/** A Bookmarks file of `count` bookmarks in the bar, each with a title of its own. */
function writeBookmarks(dir, count) {
  const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  data.roots.bookmark_bar.children = Array.from({ length: count }, (_, i) => ({
    type: "url",
    name: `Bookmark number ${i}`,
    url: `https://example.com/${i}`,
    date_added: "13349793600000000",
  }));
  data.roots.other.children = [];
  if (data.roots.synced) data.roots.synced.children = [];
  const file = path.join(dir, "Bookmarks");
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

/** The texts the fake embedder has embedded, from its log. */
function embedded(log) {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

async function until(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("e2e: closing stdin stops the indexing, and the server exits without embedding the rest", async () => {
  const dir = tempDir();
  const total = 20 * TITLE_BATCH;
  const bookmarks = writeBookmarks(dir, total);
  const log = path.join(dir, "embedded.log");
  const delayMs = 300;
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
    env: {
      ...process.env,
      CHROME_BOOKMARKS_PATH: bookmarks,
      MNEMOS_CACHE_DIR: path.join(dir, "cache"),
      MNEMOS_EMBEDDER: "fake",
      MNEMOS_FAKE_EMBED_LOG: log,
      // 20 batches of titles: 6 s to embed them all.
      MNEMOS_FAKE_EMBED_DELAY_MS: String(delayMs),
      MNEMOS_FETCH_PAGES: "0",
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mnemos-shutdown", version: "0.0.0" } },
      }) + "\n",
    );
    await until(() => embedded(log) >= TITLE_BATCH, "the first batch of titles to be embedded");
    const closing = Date.now();
    child.stdin.end();
    assert.deepEqual(await exited, { code: 0, signal: null });
    const took = Date.now() - closing;
    // At most the embed() call in progress, and the next batch's start, after stdin closes.
    assert.ok(took < 1_500, `took ${took} ms to exit`);
    assert.ok(embedded(log) <= 3 * TITLE_BATCH, `embedded ${embedded(log)} of ${total} titles`);
  } finally {
    child.kill("SIGKILL");
  }
});

/** An embedder whose embed() calls wait until released; once released, they no longer wait. */
function heldEmbedder() {
  const fake = new FakeEmbedder();
  const held = [];
  let released = false;
  let calls = 0;
  return {
    id: fake.id,
    revision: fake.revision,
    dim: fake.dim,
    relevance: fake.relevance,
    status: () => fake.status(),
    embed(texts, kind) {
      calls++;
      if (released) return fake.embed(texts, kind);
      return new Promise((resolve) => held.push(() => resolve(fake.embed(texts, kind))));
    },
    calls: () => calls,
    release: () => {
      released = true;
      held.splice(0).forEach((go) => go());
    },
  };
}

test("Indexer: close() mid-run drops the run queued after it, and schedules none again", async () => {
  const dir = tempDir();
  const bookmarks = writeBookmarks(dir, 3 * TITLE_BATCH);
  const embedder = heldEmbedder();
  const entries = [...Array(3 * TITLE_BATCH).keys()].map((i) => ({
    folder: "",
    node: { type: "url", name: `Bookmark number ${i}`, url: `https://example.com/${i}`, guid: `g${i}` },
  }));
  const indexer = new Indexer({ embedder, bookmarksFile: () => bookmarks, entries: () => entries, dir: path.join(dir, "cache"), debounceMs: 0 });
  indexer.start();
  await until(() => embedder.calls() === 1, "the first embed() call");
  // A change seen mid-run queues a full run once this one ends.
  fs.appendFileSync(bookmarks, " ");
  indexer.checkForChanges();
  await new Promise((resolve) => setTimeout(resolve, 20));
  indexer.close();
  embedder.release();
  await indexer.idle();
  indexer.checkForChanges();
  indexer.pagesChanged();
  indexer.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await indexer.idle();
  assert.equal(embedder.calls(), 1, "no batch after the one in progress, and no run after close()");
});

test("stopInstalls: kills the npm install running and refuses later ones", { timeout: 60_000 }, async () => {
  const dir = tempDir();
  // A stand-in npm that never finishes: npmCommand runs the npm-cli.js beside npm_execpath.
  const bin = path.join(dir, "npm-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm-cli.js"), "setInterval(() => {}, 1000);\n");
  const env = { ...process.env, npm_execpath: path.join(bin, "npm-cli.js") };
  const cache = path.join(dir, "cache");
  const missing = async () => {
    throw new Error(`Cannot find package '${TRANSFORMERS}' (test)`);
  };
  let installing = false;
  const load = loadTransformers({ dir: cache, spec: "file:/nowhere", importBeside: missing, env, onInstall: () => (installing = true) });
  const settled = load.then(
    () => assert.fail("the install should not finish"),
    (err) => err,
  );
  await until(() => installing, "the install to start");
  // Let npm start.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopping = Date.now();
  stopInstalls();
  const err = await settled;
  assert.ok(err instanceof RuntimeInstallError, String(err));
  assert.match(err.message, /npm install failed/);
  assert.ok(Date.now() - stopping < 5_000, `took ${Date.now() - stopping} ms`);
  assert.deepEqual(fs.readdirSync(runtimeDir(cache)), [], "no temporary folder left");
  await assert.rejects(
    loadTransformers({ dir: cache, spec: "file:/nowhere", importBeside: missing, env }),
    (e) => e instanceof RuntimeInstallError && /shutting down/.test(e.message),
  );
});
