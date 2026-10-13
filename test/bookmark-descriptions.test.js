// Bookmark descriptions in the title index: lib.describe(node) goes into the
// embedding text after the title and into the index's description column, and
// a changed or removed description re-embeds that bookmark alone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { FakeEmbedder } from "../dist/embedder.js";
import { Indexer, bookmarkRows, embeddingText } from "../dist/indexer.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-descriptions-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function freshDir() {
  return path.join(root, `case-${++n}`);
}

function node(name, url, extra = {}) {
  return { type: "url", name, url, ...extra };
}

test("embeddingText: the description goes after the title, trimmed; a blank one adds no line", () => {
  const bookmark = { title: "LiveKit Agents", folder_path: "Bar", url: "https://github.com/livekit/agents" };
  assert.equal(
    embeddingText({ ...bookmark, description: "  Realtime voice agents  " }),
    "LiveKit Agents\nRealtime voice agents\nBar\ngithub livekit agents",
  );
  const without = "LiveKit Agents\nBar\ngithub livekit agents";
  assert.equal(embeddingText(bookmark), without);
  assert.equal(embeddingText({ ...bookmark, description: null }), without);
  assert.equal(embeddingText({ ...bookmark, description: "   " }), without);
});

test("bookmark rows: the description is lib.describe(node), null when there is none", () => {
  const rows = bookmarkRows([
    { folder: "Bar", node: node("Vivaldi", "https://a.example/", { guid: "g1", meta_info: { Description: " About A " } }) },
    { folder: "Bar", node: node("Firefox", "https://b.example/", { description: "About B" }) },
    { folder: "Bar", node: node("None", "https://c.example/", { guid: "g3" }) },
    { folder: "Bar", node: node("Blank", "https://d.example/", { guid: "g4", meta_info: { Description: "  " } }) },
  ]);
  assert.deepEqual(
    rows.map((r) => r.description),
    ["About A", "About B", null, null],
  );
  const plain = bookmarkRows([{ folder: "Bar", node: node("Vivaldi", "https://a.example/", { guid: "g1" }) }]);
  assert.notEqual(rows[0].text_hash, plain[0].text_hash, "a description changes the text hash");
});

test("upsertBookmarks: a null description clears the stored one, an omitted one keeps it", () => {
  const store = IndexStore.open({ bookmarksFile: "/nowhere/Bookmarks", dir: freshDir() });
  const row = (extra) => ({ guid: "g1", url: "https://a.example/", title: "A", folder_path: "Bar", text_hash: "h", ...extra });
  store.upsertBookmarks([row({ description: "About A" })]);
  assert.equal(store.upsertBookmarks([row({})]), 0, "omitted: nothing changes");
  assert.equal(store.getBookmark("g1").description, "About A");
  assert.equal(store.upsertBookmarks([row({ description: null })]), 1, "null: the row changes");
  assert.equal(store.getBookmark("g1").description, null);
  assert.equal(store.upsertBookmarks([row({ description: null })]), 0, "null again: nothing changes");
  store.close();
});

/** The fake embedder, keeping what it embeds. */
function countingEmbedder() {
  const fake = new FakeEmbedder();
  const embedder = {
    id: fake.id,
    revision: fake.revision,
    dim: fake.dim,
    texts: [],
    status: () => fake.status(),
    async embed(texts, kind) {
      embedder.texts.push(...texts);
      return fake.embed(texts, kind);
    },
  };
  return embedder;
}

test("indexer: descriptions are stored and embedded; a changed or removed one re-embeds that bookmark", async () => {
  const dir = freshDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  let entries = [
    { folder: "Bar", node: node("A", "https://a.example/", { guid: "g1", meta_info: { Description: "About A" } }) },
    { folder: "Bar", node: node("B", "https://b.example/", { guid: "g2" }) },
  ];
  const embedder = countingEmbedder();
  const indexer = new Indexer({ embedder, bookmarksFile: () => bookmarksFile, entries: () => entries, dir });
  const stored = (guid) => {
    const store = IndexStore.open({ bookmarksFile, dir });
    try {
      return store.getBookmark(guid);
    } finally {
      store.close();
    }
  };
  try {
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts.sort(), ["A\nAbout A\nBar\na", "B\nBar\nb"]);
    assert.equal(stored("g1").description, "About A");
    assert.equal(stored("g2").description, null);

    // Another run with nothing changed embeds nothing.
    indexer.start();
    await indexer.idle();
    assert.equal(embedder.texts.length, 2);

    entries = [
      { folder: "Bar", node: node("A", "https://a.example/", { guid: "g1", meta_info: { Description: "All about A" } }) },
      entries[1],
    ];
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts.slice(2), ["A\nAll about A\nBar\na"]);
    assert.equal(stored("g1").description, "All about A");
    assert.ok(stored("g1").vector);

    entries = [{ folder: "Bar", node: node("A", "https://a.example/", { guid: "g1" }) }, entries[1]];
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts.slice(3), ["A\nBar\na"]);
    assert.equal(stored("g1").description, null, "a removed description is cleared");
    assert.ok(stored("g1").vector);
    assert.equal(indexer.status().state, "ready");
  } finally {
    indexer.close();
  }
});
