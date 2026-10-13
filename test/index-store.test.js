// Unit tests for the local index store (index-store.ts). Every store lives in
// a fresh temporary MNEMOS_CACHE_DIR, so nothing is written anywhere else.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  IndexStore,
  SCHEMA_VERSION,
  cacheDir,
  indexFile,
  vectorToBlob,
  blobToVector,
  normalize,
  dot,
  isCorrupt,
} from "../dist/index-store.js";

let root;
const savedCacheDir = process.env.MNEMOS_CACHE_DIR;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-index-store-"));
  // Also covers any code path that falls back to cacheDir() from process.env.
  process.env.MNEMOS_CACHE_DIR = root;
});

after(() => {
  if (savedCacheDir === undefined) delete process.env.MNEMOS_CACHE_DIR;
  else process.env.MNEMOS_CACHE_DIR = savedCacheDir;
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A fresh cache directory inside the test root. */
function freshDir() {
  return path.join(root, `case-${++n}`);
}

const BOOKMARKS = "/profiles/Default/Bookmarks";

function row(guid, url, title = guid, extra = {}) {
  return { guid, url, title, folder_path: "Bookmarks Bar", text_hash: `h:${title}`, ...extra };
}

function vec(...values) {
  return new Float32Array(values);
}

// --- location ---------------------------------------------------------------

test("cacheDir: MNEMOS_CACHE_DIR wins on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(cacheDir({ MNEMOS_CACHE_DIR: "/tmp/x", XDG_CACHE_HOME: "/xdg" }, platform, "/home/u"), "/tmp/x");
  }
});

test("cacheDir: macOS uses ~/Library/Caches/mnemos", () => {
  assert.equal(cacheDir({}, "darwin", "/Users/u"), "/Users/u/Library/Caches/mnemos");
});

test("cacheDir: Linux uses XDG_CACHE_HOME, else ~/.cache", () => {
  assert.equal(cacheDir({ XDG_CACHE_HOME: "/xdg/cache" }, "linux", "/home/u"), "/xdg/cache/mnemos");
  assert.equal(cacheDir({}, "linux", "/home/u"), "/home/u/.cache/mnemos");
  assert.equal(cacheDir({}, "freebsd", "/home/u"), "/home/u/.cache/mnemos");
});

test("cacheDir: an empty or relative XDG_CACHE_HOME, or an empty MNEMOS_CACHE_DIR, is ignored", () => {
  assert.equal(cacheDir({ XDG_CACHE_HOME: "" }, "linux", "/home/u"), "/home/u/.cache/mnemos");
  assert.equal(cacheDir({ XDG_CACHE_HOME: "rel/cache" }, "linux", "/home/u"), "/home/u/.cache/mnemos");
  assert.equal(cacheDir({ MNEMOS_CACHE_DIR: "" }, "linux", "/home/u"), "/home/u/.cache/mnemos");
});

test("cacheDir: Windows uses %LOCALAPPDATA%\\mnemos\\Cache, else the home's AppData\\Local", () => {
  assert.equal(
    cacheDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u"),
    "C:\\Users\\u\\AppData\\Local\\mnemos\\Cache",
  );
  assert.equal(cacheDir({}, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Local\\mnemos\\Cache");
});

test("indexFile: one file per absolute Bookmarks path, named by 16 hex of its sha256", () => {
  const file = indexFile(BOOKMARKS, "/cache");
  assert.match(path.basename(file), /^index-[0-9a-f]{16}\.sqlite$/);
  assert.equal(path.dirname(file), path.normalize("/cache"));
  assert.notEqual(indexFile("/profiles/Profile 1/Bookmarks", "/cache"), file);
  // A relative path names the same file as its absolute form.
  assert.equal(indexFile("Bookmarks", "/cache"), indexFile(path.resolve("Bookmarks"), "/cache"));
});

// --- create and open --------------------------------------------------------

test("open: creates the directory and a WAL-mode database with the schema version", () => {
  const dir = freshDir();
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  assert.equal(store.file, indexFile(BOOKMARKS, dir));
  assert.ok(fs.existsSync(store.file));
  assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
  assert.equal(store.movedAside, undefined);
  store.close();

  const db = new DatabaseSync(indexFile(BOOKMARKS, dir));
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(
    tables.map((t) => t.name),
    ["bookmarks", "chunks", "lease", "meta", "pages"],
  );
  db.close();
});

test("open: without a dir, the index goes in MNEMOS_CACHE_DIR", () => {
  const store = IndexStore.open({ bookmarksFile: "/elsewhere/Bookmarks" });
  assert.equal(path.dirname(store.file), root);
  store.close();
});

test("open: reopening keeps the data", () => {
  const dir = freshDir();
  let store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.close();
  store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  assert.equal(store.getBookmark("g1").url, "https://a.example/");
  store.close();
});

test("open: a file from an older schema version is rebuilt", () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(indexFile(BOOKMARKS, dir));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("INSERT INTO meta VALUES ('schema_version', '0'), ('model_id', 'old')");
  db.exec("CREATE TABLE bookmarks (url TEXT)");
  db.exec("INSERT INTO bookmarks VALUES ('https://stale.example/')");
  db.close();

  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
  assert.equal(store.getMeta("model_id"), undefined);
  assert.deepEqual(store.bookmarkGuids(), []);
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  assert.equal(store.getBookmark("g1").title, "g1");
  store.close();
});

test("open: a file from a newer schema version is rebuilt too", () => {
  const dir = freshDir();
  let store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.setMeta("schema_version", String(SCHEMA_VERSION + 1));
  store.close();
  store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
  assert.deepEqual(store.bookmarkGuids(), []);
  store.close();
});

test("open: a corrupt file is moved aside and a new index created", () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = indexFile(BOOKMARKS, dir);
  const garbage = "this is not a database ".repeat(100);
  fs.writeFileSync(file, garbage);

  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, now: () => 1234 });
  assert.equal(store.movedAside, `${file}.corrupt-1234`);
  assert.equal(fs.readFileSync(store.movedAside, "utf8"), garbage);
  assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  assert.deepEqual(store.bookmarkGuids(), ["g1"]);
  store.close();
});

test("open: a database whose header is overwritten is recovered too", () => {
  const dir = freshDir();
  let store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.close();
  const fd = fs.openSync(store.file, "r+");
  fs.writeSync(fd, Buffer.alloc(100, 0xab), 0, 100, 0);
  fs.closeSync(fd);

  store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  assert.ok(store.movedAside);
  assert.deepEqual(store.bookmarkGuids(), []);
  store.close();
});

test("open: damage deep in the file, past the pages open() reads, is recovered too", () => {
  const dir = freshDir();
  let store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push(row(`g${i}`, `https://e${i}.example/`, `title ${i} `.repeat(5)));
  store.syncBookmarks(rows);
  store.close();
  const pageSize = 4096;
  assert.ok(fs.statSync(store.file).size > 60 * pageSize);
  const fd = fs.openSync(store.file, "r+");
  fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, 50 * pageSize);
  fs.closeSync(fd);

  store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir });
  assert.ok(store.movedAside);
  assert.deepEqual(store.bookmarkGuids(), []);
  store.syncBookmarks(rows.slice(0, 10));
  assert.equal(store.bookmarkGuids().length, 10);
  store.close();
});

test("isCorrupt: corruption errors only, not a busy or other error", () => {
  assert.equal(isCorrupt({ errcode: 11 }), true);
  assert.equal(isCorrupt({ errcode: 26 }), true);
  assert.equal(isCorrupt({ errcode: 11 | (1 << 8) }), true); // an extended SQLITE_CORRUPT code
  assert.equal(isCorrupt({ errcode: 5 }), false); // SQLITE_BUSY
  assert.equal(isCorrupt(new Error("file is not a database")), true);
  assert.equal(isCorrupt(new Error("EACCES")), false);
});

// --- bookmarks --------------------------------------------------------------

test("upsertBookmarks: inserts, updates changed rows only, and keeps duplicates of a URL apart", () => {
  let t = 100;
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir(), now: () => t });
  assert.equal(
    store.upsertBookmarks([
      row("g1", "https://a.example/", "A"),
      row("g2", "https://a.example/", "A again", { folder_path: "Other" }),
    ]),
    2,
  );
  assert.equal(store.getBookmark("g1").folder_path, "Bookmarks Bar");
  assert.equal(store.getBookmark("g2").folder_path, "Other");
  assert.equal(store.getBookmark("g1").updated_at, 100);
  assert.equal(store.getBookmark("g1").description, null);

  t = 200;
  // Unchanged rows are not touched.
  assert.equal(store.upsertBookmarks([row("g1", "https://a.example/", "A")]), 0);
  assert.equal(store.getBookmark("g1").updated_at, 100);
  // A changed row is.
  assert.equal(store.upsertBookmarks([row("g1", "https://a.example/", "A", { folder_path: "Moved" })]), 1);
  assert.equal(store.getBookmark("g1").folder_path, "Moved");
  assert.equal(store.getBookmark("g1").updated_at, 200);
  store.close();
});

test("upsertBookmarks: a description is kept when later rows pass none", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([row("g1", "https://a.example/", "A", { description: "About A" })]);
  store.upsertBookmarks([row("g1", "https://a.example/", "A")]);
  assert.equal(store.getBookmark("g1").description, "About A");
  store.upsertBookmarks([row("g1", "https://a.example/", "A", { description: "New" })]);
  assert.equal(store.getBookmark("g1").description, "New");
  store.close();
});

test("upsertBookmarks: a new text_hash drops the title vector, the same one keeps it", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([row("g1", "https://a.example/", "A")]);
  assert.deepEqual(store.bookmarksWithoutVector().map((b) => b.guid), ["g1"]);
  assert.equal(store.setBookmarkVector("g1", "h:A", vec(1, 0)), true);
  assert.deepEqual(store.bookmarksWithoutVector(), []);

  store.upsertBookmarks([row("g1", "https://a.example/", "A", { folder_path: "Moved" })]);
  assert.deepEqual(store.getBookmark("g1").vector, vec(1, 0));

  store.upsertBookmarks([row("g1", "https://a.example/", "B")]);
  assert.equal(store.getBookmark("g1").vector, null);
  // A vector computed from the old text is refused.
  assert.equal(store.setBookmarkVector("g1", "h:A", vec(1, 0)), false);
  assert.equal(store.setBookmarkVector("g1", "h:B", vec(0, 1)), true);
  store.close();
});

test("deleteBookmarks: removes rows, and a URL's page and chunks only with its last bookmark", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([row("g1", "https://a.example/"), row("g2", "https://a.example/")]);
  store.upsertPage({ url: "https://a.example/", status: "ok" });
  store.replaceChunks("https://a.example/", ["one", "two"]);

  assert.equal(store.deleteBookmarks(["g1", "missing"]), 1);
  assert.deepEqual(store.bookmarkGuids(), ["g2"]);
  assert.equal(store.getPage("https://a.example/").status, "ok");
  assert.equal(store.getChunks("https://a.example/").length, 2);

  assert.equal(store.deleteBookmarks(["g2"]), 1);
  assert.equal(store.getPage("https://a.example/"), undefined);
  assert.deepEqual(store.getChunks("https://a.example/"), []);
  store.close();
});

test("syncBookmarks: leaves exactly the given rows", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([row("g1", "https://a.example/"), row("g2", "https://b.example/")]);
  store.setBookmarkVector("g1", "h:g1", vec(1));
  store.upsertPage({ url: "https://b.example/", status: "pending" });

  const result = store.syncBookmarks([row("g1", "https://a.example/"), row("g3", "https://c.example/")]);
  assert.deepEqual(result, { changed: 1, deleted: 1 });
  assert.deepEqual(store.bookmarkGuids(), ["g1", "g3"]);
  assert.deepEqual(store.getBookmark("g1").vector, vec(1));
  assert.equal(store.getPage("https://b.example/"), undefined);
  store.close();
});

// --- vectors ----------------------------------------------------------------

test("vectors: Float32Array to BLOB and back is exact, through the database too", () => {
  const values = vec(0, -0, 1, -1, Math.PI, 1e-38, 3.4028234663852886e38, Number.EPSILON, 0.1, -123.456);
  assert.deepEqual(blobToVector(vectorToBlob(values)), values);
  // Bit for bit, including -0.
  assert.deepEqual(
    new Uint8Array(blobToVector(vectorToBlob(values)).buffer),
    new Uint8Array(values.buffer),
  );
  // A view into a larger buffer, at an offset, encodes only its own elements.
  const view = new Float32Array(new Float32Array([9, 1.5, 2.5, 9]).buffer, 4, 2);
  assert.deepEqual(blobToVector(vectorToBlob(view)), vec(1.5, 2.5));
  // A BLOB at an odd offset still decodes.
  const odd = new Uint8Array(1 + 8).subarray(1);
  odd.set(vectorToBlob(vec(1.5, 2.5)));
  assert.deepEqual(blobToVector(odd), vec(1.5, 2.5));
  assert.throws(() => blobToVector(new Uint8Array(3)));

  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  const big = new Float32Array(384).map((_, i) => Math.sin(i) / 7);
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.setBookmarkVector("g1", "h:g1", big);
  assert.deepEqual(store.getBookmark("g1").vector, big);
  store.replaceChunks("https://a.example/", ["text"]);
  store.setChunkVector("https://a.example/", 0, "text", values);
  assert.deepEqual(store.getChunks("https://a.example/")[0].vector, values);
  store.close();
});

test("normalize and dot: unit length, cosine similarity", () => {
  const v = normalize(vec(3, 4));
  assert.ok(Math.abs(v[0] - 0.6) < 1e-7 && Math.abs(v[1] - 0.8) < 1e-7);
  assert.ok(Math.abs(dot(v, v) - 1) < 1e-6);
  assert.deepEqual(normalize(vec(0, 0)), vec(0, 0));
  assert.equal(dot(vec(1, 0), vec(0, 1)), 0);
  assert.throws(() => dot(vec(1), vec(1, 2)));
});

test("nearestBookmarks and nearestChunks: best first, limited, skipping rows with no vector", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([
    row("east", "https://e.example/"),
    row("north", "https://n.example/"),
    row("northeast", "https://ne.example/"),
    row("unembedded", "https://u.example/"),
  ]);
  store.setBookmarkVector("east", "h:east", normalize(vec(1, 0)));
  store.setBookmarkVector("north", "h:north", normalize(vec(0, 1)));
  store.setBookmarkVector("northeast", "h:northeast", normalize(vec(1, 1)));

  const query = normalize(vec(1, 0.1));
  assert.deepEqual(
    store.nearestBookmarks(query, 10).map((b) => b.guid),
    ["east", "northeast", "north"],
  );
  const top = store.nearestBookmarks(query, 2);
  assert.deepEqual(top.map((b) => b.guid), ["east", "northeast"]);
  assert.ok(top[0].score > top[1].score);
  assert.deepEqual(store.nearestBookmarks(query, 0), []);

  store.replaceChunks("https://n.example/", ["up", "right", "pending"]);
  store.setChunkVector("https://n.example/", 0, "up", normalize(vec(0, 1)));
  store.setChunkVector("https://n.example/", 1, "right", normalize(vec(1, 0)));
  assert.deepEqual(
    store.nearestChunks(query, 5).map((c) => c.text),
    ["right", "up"],
  );
  store.close();
});

// --- pages and chunks -------------------------------------------------------

test("pages: upsert and read back, with defaults", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.upsertPage({ url: "https://a.example/", status: "pending" });
  assert.deepEqual(store.getPage("https://a.example/"), {
    url: "https://a.example/",
    status: "pending",
    final_url: null,
    fetched_at: null,
    fail_count: 0,
    next_attempt_at: null,
    content_hash: null,
    reason: null,
    text: null,
  });
  store.upsertPage({
    url: "https://a.example/",
    status: "failed",
    fail_count: 2,
    next_attempt_at: 5000,
    reason: "HTTP 503",
  });
  const page = store.getPage("https://a.example/");
  assert.equal(page.status, "failed");
  assert.equal(page.fail_count, 2);
  assert.equal(page.next_attempt_at, 5000);
  assert.throws(() => store.upsertPage({ url: "https://a.example/", status: "bogus" }));
  store.close();
});

test("chunks: replacing them drops the old ones and their vectors", () => {
  const store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir: freshDir() });
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.replaceChunks("https://a.example/", ["one", "two"]);
  store.setChunkVector("https://a.example/", 0, "one", vec(1));
  assert.deepEqual(store.chunksWithoutVector().map((c) => c.text), ["two"]);

  store.replaceChunks("https://a.example/", ["uno"]);
  assert.deepEqual(store.getChunks("https://a.example/"), [
    { url: "https://a.example/", ordinal: 0, text: "uno", vector: null },
  ]);
  // A vector for text that is no longer there is refused.
  assert.equal(store.setChunkVector("https://a.example/", 0, "one", vec(1)), false);
  store.close();
});

// --- model change -----------------------------------------------------------

test("useModel: a different model or revision drops every vector and keeps the rows", () => {
  const dir = freshDir();
  let store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, modelId: "e5-small", modelRevision: "r1" });
  assert.equal(store.getMeta("model_id"), "e5-small");
  assert.equal(store.getMeta("model_revision"), "r1");
  store.upsertBookmarks([row("g1", "https://a.example/")]);
  store.setBookmarkVector("g1", "h:g1", vec(1, 0));
  store.replaceChunks("https://a.example/", ["text"]);
  store.setChunkVector("https://a.example/", 0, "text", vec(0, 1));
  store.close();

  // Same model: nothing dropped.
  store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, modelId: "e5-small", modelRevision: "r1" });
  assert.deepEqual(store.getBookmark("g1").vector, vec(1, 0));
  assert.equal(store.useModel("e5-small", "r1"), false);

  // New revision: vectors gone, rows kept.
  assert.equal(store.useModel("e5-small", "r2"), true);
  assert.equal(store.getBookmark("g1").vector, null);
  assert.equal(store.getBookmark("g1").url, "https://a.example/");
  assert.deepEqual(store.getChunks("https://a.example/").map((c) => [c.text, c.vector]), [["text", null]]);
  assert.equal(store.getMeta("model_revision"), "r2");

  // New model id, through open().
  store.setBookmarkVector("g1", "h:g1", vec(1, 0));
  store.close();
  store = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, modelId: "other", modelRevision: "r2" });
  assert.equal(store.getBookmark("g1").vector, null);
  assert.equal(store.getMeta("model_id"), "other");
  store.close();
});

// --- lease ------------------------------------------------------------------

test("lease: one holder at a time; renew, expire, takeover and release between two stores", () => {
  const dir = freshDir();
  let t = 1000;
  const now = () => t;
  const a = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, now });
  const b = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, now });
  assert.notEqual(a.holderId, b.holderId);
  assert.match(a.holderId, new RegExp(`^${process.pid}:`));

  // Acquire: a takes it, b sees it held.
  assert.equal(a.acquireLease("fetcher", 100), true);
  assert.equal(b.acquireLease("fetcher", 100), false);
  assert.deepEqual(b.getLease("fetcher"), { holder: a.holderId, expires_at: 1100 });
  assert.equal(b.renewLease("fetcher", 100), false);

  // Renew: the heartbeat moves the expiry on.
  t = 1050;
  assert.equal(a.renewLease("fetcher", 100), true);
  assert.equal(a.getLease("fetcher").expires_at, 1150);
  t = 1149;
  assert.equal(b.acquireLease("fetcher", 100), false);
  // Acquiring a lease you hold renews it.
  assert.equal(a.acquireLease("fetcher", 100), true);
  assert.equal(a.getLease("fetcher").expires_at, 1249);

  // Expire and take over: once a misses its heartbeat, b can take it, and a learns it lost it.
  t = 1249;
  assert.equal(a.renewLease("fetcher", 100), false);
  assert.equal(b.acquireLease("fetcher", 100), true);
  assert.equal(b.getLease("fetcher").holder, b.holderId);
  assert.equal(a.renewLease("fetcher", 100), false);
  assert.equal(a.acquireLease("fetcher", 100), false);

  // Release: only the holder's release counts.
  a.releaseLease("fetcher");
  assert.equal(a.getLease("fetcher").holder, b.holderId);
  b.releaseLease("fetcher");
  assert.equal(a.getLease("fetcher"), undefined);
  assert.equal(a.acquireLease("fetcher", 100), true);

  // Leases are independent by name.
  assert.equal(b.acquireLease("other", 100), true);
  a.close();
  b.close();
});

test("lease: a store opened after the holder closed still sees the lease until it expires", () => {
  const dir = freshDir();
  let t = 0;
  const a = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, now: () => t });
  assert.equal(a.acquireLease("fetcher", 30_000), true);
  a.close();
  const b = IndexStore.open({ bookmarksFile: BOOKMARKS, dir, now: () => t });
  assert.equal(b.acquireLease("fetcher", 30_000), false);
  t = 30_000;
  assert.equal(b.acquireLease("fetcher", 30_000), true);
  b.close();
});

test("tests write nothing outside MNEMOS_CACHE_DIR: the default directory resolves to it", () => {
  // Every store above is opened in a directory under `root`, or with no dir,
  // which resolves through process.env.MNEMOS_CACHE_DIR to `root` itself.
  assert.equal(cacheDir(), root);
  assert.ok(fs.readdirSync(root).some((name) => /^index-[0-9a-f]{16}\.sqlite$/.test(name)));
});
