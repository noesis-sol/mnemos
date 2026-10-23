// A page's chunks are embedded with its bookmark's title before them
// (chunkEmbeddingText), so a rename has to embed them again. The indexer in
// process with a counting fake embedder: renaming a bookmark embeds its page's
// chunks again with the new title, uncut, and no other page's; deleting the
// first bookmark of a URL does the same with the next one's title. The store:
// pages.chunked_title records the title, a stale vector is not stored over a
// rename, and the version 3 to 4 migration takes each page's title as it is,
// so an upgrade embeds nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkText } from "../dist/chunk.js";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore, SCHEMA_VERSION, indexFile } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { contentHash } from "../dist/fetcher.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-chunk-titles-"));
  dirs.push(dir);
  return dir;
}

/** A FakeEmbedder that records every text it embeds. */
class CountingEmbedder extends FakeEmbedder {
  texts = [];
  async embed(texts, kind) {
    this.texts.push(...texts);
    return super.embed(texts, kind);
  }
}

const SENTENCES = (word, n) =>
  Array.from({ length: n }, (_, i) => `The ${word} note number ${i} is written out here at some length.`).join(" ");

const entry = (guid, name, url) => ({ folder: "Bar", node: { type: "url", name, url, guid } });

test("Indexer: renaming a bookmark embeds its page's chunks again with the new title, and no other page's", async () => {
  const A = "https://a.example/";
  const B = "https://b.example/";
  let list = [entry("guid-a", "Old title", A), entry("guid-b", "Other page", B)];
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const embedder = new CountingEmbedder();
  const indexer = new Indexer({ embedder, bookmarksFile: () => bookmarksFile, entries: () => list, dir, debounceMs: 10 });
  const fetched = IndexStore.open({ bookmarksFile, dir });
  const textA = SENTENCES("aardvark", 60);
  const textB = SENTENCES("bilby", 3);
  try {
    indexer.start();
    await indexer.idle();
    for (const [url, text] of [[A, textA], [B, textB]]) {
      fetched.upsertPage({ url, status: "ok", content_hash: contentHash(text), text });
    }
    indexer.pagesChanged();
    await indexer.idle();
    const chunksA = chunkText(textA);
    assert.ok(chunksA.length > 1);
    assert.equal(indexer.embeddedPages(), 2);
    const vectorB = fetched.getChunks(B)[0].vector;

    // The rename: the title vector and every chunk of A, with the new title; nothing of B.
    embedder.texts = [];
    list = [entry("guid-a", "New title", A), entry("guid-b", "Other page", B)];
    indexer.start();
    await indexer.idle();
    const chunkTexts = embedder.texts.filter((t) => t.includes("aardvark"));
    assert.deepEqual(chunkTexts, chunksA.map((c) => `New title\n${c}`));
    assert.equal(embedder.texts.length, chunksA.length + 1, embedder.texts.join("\n---\n"));
    assert.ok(!embedder.texts.some((t) => t.includes("bilby")), "B's chunks are not embedded again");
    assert.ok(!embedder.texts.some((t) => t.startsWith("Old title")));
    assert.deepEqual(fetched.getChunks(A).map((c) => c.text), chunksA, "the page is not cut again");
    assert.ok(fetched.getChunks(A).every((c) => c.vector !== null));
    assert.deepEqual(fetched.getChunks(B)[0].vector, vectorB);
    assert.equal(indexer.embeddedPages(), 2);

    // The same titles again: nothing is embedded.
    embedder.texts = [];
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts, []);

    // A second bookmark of B's URL, first by guid, then deleted: B's chunks follow its title each time.
    list = [entry("guid-a", "New title", A), entry("guid-a2", "Second bookmark", B), entry("guid-b", "Other page", B)];
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts.filter((t) => t.includes("bilby")), [`Second bookmark\n${textB}`]);
    embedder.texts = [];
    list = [entry("guid-a", "New title", A), entry("guid-b", "Other page", B)];
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts, [`Other page\n${textB}`]);
  } finally {
    indexer.close();
    fetched.close();
  }
});

function seeded(pages) {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(
    pages.map(([url, title], i) => ({ guid: `g${i}`, url, title, folder_path: "Bar", text_hash: `h${i}-${title}` })),
  );
  return { dir, bookmarksFile, store };
}

test("store: retitleChunks drops the vectors of pages whose title changed, once", () => {
  const { store } = seeded([["https://a.example/", "A"], ["https://b.example/", "B"]]);
  try {
    const v = new Float32Array([1, 0]);
    for (const url of ["https://a.example/", "https://b.example/"]) {
      store.upsertPage({ url, status: "ok", content_hash: "h", text: "text" });
      store.replaceChunks(url, ["text"], "h");
      assert.ok(store.setChunkVector(url, 0, "text", v, store.pageTitle(url)));
    }
    assert.equal(store.retitleChunks(), 0);
    store.syncBookmarks([
      { guid: "g0", url: "https://a.example/", title: "A2", folder_path: "Bar", text_hash: "h0-A2" },
      { guid: "g1", url: "https://b.example/", title: "B", folder_path: "Bar", text_hash: "h1-B" },
    ]);
    assert.equal(store.retitleChunks(), 1);
    assert.equal(store.getChunks("https://a.example/")[0].vector, null);
    assert.notEqual(store.getChunks("https://b.example/")[0].vector, null);
    assert.equal(store.retitleChunks(), 0);
    // A vector computed with the old title is not stored; one with the new title is.
    assert.equal(store.setChunkVector("https://a.example/", 0, "text", v, "A"), false);
    assert.equal(store.setChunkVector("https://a.example/", 0, "text", v, "A2"), true);
  } finally {
    store.close();
  }
});

test("store: a version 3 index gains pages.chunked_title, taken from each page's title as it is", () => {
  const { dir, bookmarksFile, store } = seeded([["https://a.example/", "A"]]);
  store.upsertPage({ url: "https://a.example/", status: "ok", content_hash: "h", text: "the page" });
  store.replaceChunks("https://a.example/", ["the page"], "h");
  store.setChunkVector("https://a.example/", 0, "the page", new Float32Array([1, 0]));
  store.close();
  const db = new DatabaseSync(indexFile(bookmarksFile, dir));
  db.exec("ALTER TABLE pages DROP COLUMN chunked_title");
  db.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  db.close();

  const reopened = IndexStore.open({ bookmarksFile, dir });
  try {
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(reopened.getMeta("schema_version"), "4");
    assert.equal(reopened.retitleChunks(), 0, "an upgrade embeds nothing again");
    assert.notEqual(reopened.getChunks("https://a.example/")[0].vector, null);
    assert.deepEqual(reopened.pagesToChunk(), []);
  } finally {
    reopened.close();
  }
});
