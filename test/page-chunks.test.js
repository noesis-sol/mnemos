// Page text cut into chunks, embedded, and ranked by semantic_search. The
// chunker (dist/chunk.js): sentence and paragraph boundaries, the overlap, the
// per-page cap, empty text, and Chinese and Greek without spaces. The store:
// which pages need cutting, and which count as embedded. The indexer in process
// with a counting fake embedder: chunks embedded with the title before them,
// unchanged text never embedded again, changed text cut again, lost text
// dropped. Over MCP (the built server, MNEMOS_EMBEDDER=fake, against a fixture
// site on 127.0.0.1): a query whose words are only in a page's body finds it,
// matched_on "page" with a snippet holding them, and a re-fetch of the same
// text embeds nothing (counted through MNEMOS_FAKE_EMBED_LOG).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CHUNK_OVERLAP,
  CHUNK_TOKENS,
  MAX_CHUNKS_PER_PAGE,
  MAX_TITLE_CHARS,
  chunkEmbeddingText,
  chunkText,
  estimateTokens,
} from "../dist/chunk.js";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore, SCHEMA_VERSION, indexFile } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { contentHash } from "../dist/fetcher.js";
import { SNIPPET_CHARS, snippet } from "../dist/semantic.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const dirs = [];
// Every test closes its clients, servers and indexers first; a directory that will not go is let be.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-page-chunks-"));
  dirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** The longest suffix of `a` that `b` starts with. */
function sharedEdge(a, b) {
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (b.startsWith(a.slice(a.length - n))) return a.slice(a.length - n);
  }
  return "";
}

/** The chunks put back together without their overlaps. */
function rejoin(chunks) {
  let text = chunks[0];
  for (let i = 1; i < chunks.length; i++) text += chunks[i].slice(sharedEdge(chunks[i - 1], chunks[i]).length);
  return text;
}

const OVERLAP_TOKENS = CHUNK_TOKENS * CHUNK_OVERLAP;

/** `n` characters from the code points `from` to `to`, in a fixed pseudo-random order, no spaces. */
function noSpaces(n, from, to) {
  let seed = 12345;
  let text = "";
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    text += String.fromCodePoint(from + (seed % (to - from + 1)));
  }
  return text;
}

// --- the chunker ---------------------------------------------------------------

test("estimateTokens: a quarter for ASCII, about a token for Chinese, in between for Greek", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("这是中文"), 4);
  assert.equal(estimateTokens("ひらがなカタカナ한국어"), 11);
  const greek = estimateTokens("καλημέρα");
  assert.ok(greek > 8 * 0.25 && greek < 8, String(greek));
});

test("chunkText: empty and blank text has no chunks; short text is one chunk", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("  \n\n \t "), []);
  assert.deepEqual(chunkText("  One short   sentence.  "), ["One short sentence."]);
  assert.deepEqual(chunkText("First paragraph.\n\n\nSecond   paragraph."), ["First paragraph.\nSecond paragraph."]);
});

test("chunkText: chunks end on sentence boundaries, near the token budget, overlapping by about 15%", () => {
  const sentences = Array.from({ length: 80 }, (_, i) => `Sentence ${i} says something about topic ${i} at moderate length.`);
  const text = sentences.join(" ");
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 4, String(chunks.length));
  for (const [i, chunk] of chunks.entries()) {
    assert.match(chunk, /^Sentence \d+ /, `chunk ${i} starts at a sentence`);
    assert.match(chunk, /length\.$/, `chunk ${i} ends at a sentence`);
    assert.ok(estimateTokens(chunk) <= CHUNK_TOKENS * 1.02, `chunk ${i}: ${estimateTokens(chunk)} tokens`);
    if (i < chunks.length - 1) assert.ok(estimateTokens(chunk) >= CHUNK_TOKENS * 0.8, `chunk ${i} is full`);
  }
  for (let i = 1; i < chunks.length; i++) {
    const shared = sharedEdge(chunks[i - 1], chunks[i]);
    const tokens = estimateTokens(shared);
    assert.ok(tokens > OVERLAP_TOKENS * 0.5 && tokens <= OVERLAP_TOKENS, `overlap ${i}: ${tokens} tokens`);
    assert.match(shared, /^Sentence \d+ .*length\.$/, "the overlap is whole sentences");
  }
  assert.equal(rejoin(chunks), text, "nothing is lost or repeated beyond the overlaps");
});

test("chunkText: paragraphs stay apart with a newline, and a chunk prefers to end where one does", () => {
  const paragraph = (n) => Array.from({ length: 6 }, (_, i) => `Paragraph ${n} sentence ${i} is fairly long and plain.`).join(" ");
  const text = Array.from({ length: 8 }, (_, n) => paragraph(n)).join("\n\n");
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.some((c) => /plain\.\nParagraph \d sentence 0 /.test(c)), "a paragraph break inside a chunk is a newline");
  assert.ok(chunks.every((c) => !c.includes("\n\n")));
});

test("chunkText: a sentence longer than a chunk is cut at spaces, the overlap a word-aligned tail", () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
  const text = words.join(" ");
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk) <= CHUNK_TOKENS, String(estimateTokens(chunk)));
    for (const word of chunk.split(" ")) assert.match(word, /^w\d+$/, "no word is cut");
  }
  for (let i = 1; i < chunks.length; i++) {
    const tokens = estimateTokens(sharedEdge(chunks[i - 1], chunks[i]));
    assert.ok(tokens > OVERLAP_TOKENS * 0.5 && tokens <= OVERLAP_TOKENS, `overlap ${i}: ${tokens}`);
  }
  assert.equal(rejoin(chunks), text);
});

test("chunkText: Chinese and Greek without spaces are cut by the character estimate", () => {
  // Not periodic, so the overlaps are found where they are.
  const chinese = noSpaces(1500, 0x4e00, 0x9fa5);
  const greek = noSpaces(2500, 0x3b1, 0x3c9);
  for (const [name, text] of [["Chinese", chinese], ["Greek", greek]]) {
    const chunks = chunkText(text);
    assert.ok(chunks.length > 2, `${name}: ${chunks.length} chunks`);
    for (const [i, chunk] of chunks.entries()) {
      assert.ok(estimateTokens(chunk) <= CHUNK_TOKENS, `${name}: ${estimateTokens(chunk)} tokens`);
      if (i < chunks.length - 1) assert.ok(estimateTokens(chunk) >= CHUNK_TOKENS * 0.8, `${name}: chunk ${i} is full`);
    }
    for (let i = 1; i < chunks.length; i++) {
      const tokens = estimateTokens(sharedEdge(chunks[i - 1], chunks[i]));
      assert.ok(tokens > OVERLAP_TOKENS * 0.5, `${name} overlap ${i}: ${tokens}`);
    }
    assert.equal(rejoin(chunks), text, `${name}: nothing lost`);
  }
  // Chinese runs about a token a character, so its chunks hold far fewer characters than English ones.
  assert.ok(Array.from(chunkText(chinese)[1]).length <= CHUNK_TOKENS);
  // Sentence ends in Chinese (。) are boundaries too.
  const sentences = "这是第一个句子，它讲的是一件事情。".repeat(80);
  for (const chunk of chunkText(sentences)) assert.match(chunk, /。$/);
});

test("chunkText: at most MAX_CHUNKS_PER_PAGE chunks, from the start of the text", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `Line ${i} of a very long page.`).join(" ");
  const chunks = chunkText(text);
  assert.equal(chunks.length, MAX_CHUNKS_PER_PAGE);
  assert.match(chunks[0], /^Line 0 /);
  assert.deepEqual(chunkText(text, { maxChunks: 3 }), chunks.slice(0, 3));
});

test("chunkEmbeddingText: the title (one line, clipped) before the chunk", () => {
  assert.equal(chunkEmbeddingText("  A   title\n", "The chunk."), "A title\nThe chunk.");
  assert.equal(chunkEmbeddingText("", "The chunk."), "The chunk.");
  const long = chunkEmbeddingText("t".repeat(500), "x");
  assert.equal(long, `${"t".repeat(MAX_TITLE_CHARS)}\nx`);
});

test("snippet: starts near the first query word when it is past the start", () => {
  const text = `${"Filler words that say nothing. ".repeat(30)}The tangerine marmalade recipe. ${"More filler. ".repeat(30)}`;
  const cut = snippet(text, SNIPPET_CHARS, ["marmalade", "tangerine"]);
  assert.ok(cut.startsWith("…"), cut);
  assert.match(cut, /tangerine marmalade/);
  assert.ok(cut.length <= SNIPPET_CHARS + 1, String(cut.length));
  assert.ok(cut.endsWith("…"));
  // A word near the start, or none found: from the start as before.
  assert.equal(snippet(text, SNIPPET_CHARS, ["filler"]), snippet(text));
  assert.equal(snippet(text, SNIPPET_CHARS, ["absent"]), snippet(text));
  // The word near the end: no trailing ellipsis.
  const end = snippet(`${"Filler words. ".repeat(40)}Then marmalade.`, SNIPPET_CHARS, ["marmalade"]);
  assert.match(end, /^….*Then marmalade\.$/);
});

// --- the store -------------------------------------------------------------------

function seeded(pages) {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(
    pages.map(([url, title], i) => ({ guid: `g${i}`, url, title, folder_path: "Bar", text_hash: `h${i}` })),
  );
  return { dir, bookmarksFile, store };
}

test("store: pagesToChunk is ok pages with new text, and pages that lost their text", () => {
  const { store } = seeded([
    ["https://a.example/", "A"],
    ["https://b.example/", "B"],
    ["https://c.example/", "C"],
    ["https://d.example/", "D"],
    ["https://e.example/", "E"],
  ]);
  try {
    store.upsertPage({ url: "https://a.example/", status: "ok", content_hash: "ha", text: "a" });
    store.upsertPage({ url: "https://b.example/", status: "ok", content_hash: "hb", text: "b" });
    store.upsertPage({ url: "https://c.example/", status: "pending" });
    store.upsertPage({ url: "https://d.example/", status: "ok", content_hash: "hd", text: "d" });
    store.upsertPage({ url: "https://e.example/", status: "ok", content_hash: "he", text: "e" });
    store.replaceChunks("https://b.example/", ["b"], "hb");
    store.replaceChunks("https://d.example/", ["d"], "hd");
    store.replaceChunks("https://e.example/", ["e"], "he");
    // d went behind a login (its text is gone), e failed for now (it keeps its chunks).
    store.upsertPage({ url: "https://d.example/", status: "needs_login", text: null });
    store.upsertPage({ url: "https://e.example/", status: "failed", fail_count: 1, text: null });
    assert.deepEqual(store.pagesToChunk(), [
      { url: "https://a.example/", content_hash: "ha" },
      { url: "https://d.example/", content_hash: null },
    ]);
    // A re-fetch of the same text leaves b alone; new text puts it back.
    store.upsertPage({ url: "https://b.example/", status: "ok", content_hash: "hb", text: "b" });
    assert.ok(!store.pagesToChunk().some((p) => p.url === "https://b.example/"));
    store.upsertPage({ url: "https://b.example/", status: "ok", content_hash: "hb2", text: "b2" });
    assert.ok(store.pagesToChunk().some((p) => p.url === "https://b.example/"));
    // Dropping the chunks with no hash clears the record too.
    store.replaceChunks("https://d.example/", []);
    assert.ok(!store.pagesToChunk().some((p) => p.url === "https://d.example/"));
    assert.equal(store.pageTitle("https://a.example/"), "A");
    assert.equal(store.pageTitle("https://nowhere.example/"), "");
  } finally {
    store.close();
  }
});

test("store: a page counts as embedded once every one of its chunks is", () => {
  const { store } = seeded([["https://a.example/", "A"], ["https://b.example/", "B"]]);
  try {
    const v = new Float32Array([1, 0]);
    store.replaceChunks("https://a.example/", ["one", "two"]);
    store.replaceChunks("https://b.example/", ["three"]);
    assert.equal(store.embeddedPageCount(), 0);
    store.setChunkVector("https://a.example/", 0, "one", v);
    store.setChunkVector("https://b.example/", 0, "three", v);
    assert.equal(store.embeddedPageCount(), 1);
    store.setChunkVector("https://a.example/", 1, "two", v);
    assert.equal(store.embeddedPageCount(), 2);
  } finally {
    store.close();
  }
});

test("store: a version 2 index gains pages.chunked_hash and keeps its rows", () => {
  const { dir, bookmarksFile, store } = seeded([["https://a.example/", "A"]]);
  store.upsertPage({ url: "https://a.example/", status: "ok", content_hash: "h", text: "the page" });
  store.close();
  const db = new DatabaseSync(indexFile(bookmarksFile, dir));
  db.exec("ALTER TABLE pages DROP COLUMN chunked_hash");
  db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  db.close();

  const reopened = IndexStore.open({ bookmarksFile, dir });
  try {
    assert.equal(reopened.getMeta("schema_version"), String(SCHEMA_VERSION));
    assert.equal(reopened.getPage("https://a.example/").text, "the page");
    assert.deepEqual(reopened.pagesToChunk(), [{ url: "https://a.example/", content_hash: "h" }]);
  } finally {
    reopened.close();
  }
});

// --- the indexer, in process -----------------------------------------------------

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

test("Indexer: chunks fetched pages, embeds them after the title, and only again when the text changes", async () => {
  const urls = ["https://a.example/", "https://b.example/", "https://c.example/"];
  const list = urls.map((url, i) => ({ folder: "Bar", node: { type: "url", name: `Title ${i}`, url, guid: `guid-${i}` } }));
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const embedder = new CountingEmbedder();
  const indexer = new Indexer({ embedder, bookmarksFile: () => bookmarksFile, entries: () => list, dir, debounceMs: 10 });
  // The fetcher's side: its own store on the same file.
  const fetched = IndexStore.open({ bookmarksFile, dir });
  const store = (fn) => fn(fetched);
  const setText = (url, text) =>
    store((s) => s.upsertPage({ url, status: "ok", content_hash: contentHash(text), text }));
  try {
    indexer.start();
    await indexer.idle();
    assert.equal(indexer.embeddedPages(), 0);
    embedder.texts = [];

    const long = SENTENCES("aardvark", 60);
    setText(urls[0], long);
    setText(urls[1], "A short page about the bilby, long enough to keep.");
    indexer.pagesChanged();
    await indexer.idle();

    const chunksA = store((s) => s.getChunks(urls[0]));
    assert.deepEqual(chunksA.map((c) => c.text), chunkText(long));
    assert.ok(chunksA.length > 1);
    assert.ok(chunksA.every((c) => c.vector !== null));
    assert.equal(store((s) => s.getChunks(urls[1])).length, 1);
    assert.equal(indexer.embeddedPages(), 2);
    assert.equal(embedder.texts.length, chunksA.length + 1);
    assert.ok(embedder.texts.includes(`Title 0\n${chunksA[0].text}`), "the title goes before the chunk");

    // The same text fetched again: nothing is cut or embedded again.
    embedder.texts = [];
    setText(urls[0], long);
    indexer.pagesChanged();
    await indexer.idle();
    assert.deepEqual(embedder.texts, []);
    assert.ok(store((s) => s.getChunks(urls[0])).every((c) => c.vector !== null));

    // New text: cut and embedded again. Text gone (a login wall): its chunks go.
    setText(urls[0], SENTENCES("echidna", 3));
    store((s) => s.upsertPage({ url: urls[1], status: "needs_login", reason: "password field", text: null }));
    indexer.pagesChanged();
    await indexer.idle();
    assert.equal(embedder.texts.length, 1);
    assert.match(embedder.texts[0], /^Title 0\nThe echidna note number 0/);
    assert.deepEqual(store((s) => s.getChunks(urls[1])), []);
    assert.equal(indexer.embeddedPages(), 1);

    // The query finds the page through its chunk.
    const [query] = await embedder.embed(["echidna"], "query");
    const page = indexer.scores(query).pages.get(urls[0]);
    assert.ok(page.score > 0.2, String(page.score));
    assert.match(page.text, /echidna/);

    // Chunks left without vectors by an earlier process are embedded at the next start.
    store((s) => s.replaceChunks(urls[2], ["Left over from before."], "x"));
    embedder.texts = [];
    indexer.start();
    await indexer.idle();
    assert.deepEqual(embedder.texts, ["Title 2\nLeft over from before."]);
  } finally {
    indexer.close();
    fetched.close();
  }
});

// --- over MCP --------------------------------------------------------------------

function articlePage(title, paragraphs) {
  return (
    `<!doctype html><html><head><title>${title}</title></head><body>` +
    `<article><h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join("")}</article></body></html>`
  );
}

/** Words in the body only: no title, URL or folder of the fixture has them. */
const MARMALADE = articlePage(
  "Kitchen notes",
  Array.from({ length: 6 }, (_, i) => `Tangerine marmalade, batch ${i}: tangerine marmalade sets slowly, so stir the tangerine marmalade.`),
);
const lighthouse = (word) =>
  articlePage(
    "Coast notes",
    Array.from({ length: 6 }, (_, i) => `The ${word} orchard, visit ${i}: the ${word} orchard keeps the ${word} orchard keeper busy all year.`),
  );

/** A node:http server on 127.0.0.1 serving `pages` (path to HTML, changeable), counting requests. */
async function fixtureSite(pages) {
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    counts.set(p, (counts.get(p) ?? 0) + 1);
    if (pages[p] === undefined) return res.writeHead(404).end("no such page");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pages[p]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    host,
    url: (p) => `http://${host}${p}`,
    count: (p) => counts.get(p) ?? 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function startServer({ bookmarks, cache, site, log }) {
  const client = new Client({ name: "mnemos-page-chunks", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: bookmarks,
        MNEMOS_CACHE_DIR: cache,
        MNEMOS_EMBEDDER: "fake",
        MNEMOS_FAKE_EMBED_LOG: log,
        MNEMOS_FETCH_ALLOW_HOSTS: site.host,
        MNEMOS_FETCH_PAGES: "",
      },
      stderr: "ignore",
    }),
  );
  return client;
}

async function search(client, query) {
  const result = await client.callTool({ name: "semantic_search", arguments: { query } });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

function pageRows(bookmarks, cache) {
  const db = new DatabaseSync(indexFile(bookmarks, cache));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return new Map(db.prepare("SELECT url, fetched_at, content_hash FROM pages").all().map((r) => [r.url, r]));
  } finally {
    db.close();
  }
}

const embedded = (log, pattern) =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => pattern.test(line)).length : 0;

test("e2e: words only in a page's body find it, matched_on page with a snippet; the same text is not embedded again", async () => {
  const pages = { "/kitchen": MARMALADE, "/coast": lighthouse("lighthouse") };
  const site = await fixtureSite(pages);
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const log = path.join(dir, "embedded.log");
  const bookmarks = path.join(dir, "Bookmarks");
  const day = 13_300_000_000_000_000;
  const children = [
    // Newest last: /kitchen is fetched first.
    { type: "url", name: "Seaside reading", url: site.url("/coast"), date_added: String(day) },
    { type: "url", name: "Recipes to try", url: site.url("/kitchen"), date_added: String(day + 1_000_000) },
  ];
  const folder = (name, kids = []) => ({ type: "folder", name, children: kids });
  fs.writeFileSync(
    bookmarks,
    JSON.stringify({ checksum: "x", version: 1, roots: { bookmark_bar: folder("Bookmarks bar", children), other: folder("Other bookmarks"), synced: folder("Mobile bookmarks") } }),
  );

  let client = await startServer({ bookmarks, cache, site, log });
  let before;
  try {
    const data = await until(async () => {
      const d = await search(client, "tangerine marmalade");
      return d.results.some((r) => r.matched_on === "page") && /pages 2\/2$/.test(d.status.progress) ? d : null;
    }, "the kitchen page's chunks to be embedded");
    const hit = data.results[0];
    assert.equal(hit.title, "Recipes to try");
    assert.equal(hit.url, site.url("/kitchen"));
    assert.equal(hit.matched_on, "page");
    assert.match(hit.snippet, /tangerine marmalade/i);
    assert.ok(!data.results.some((r) => r.title === "Seaside reading"), "the unrelated page is not a hit");
    // Embedded with the title before the chunk.
    assert.ok(embedded(log, /^"Recipes to try\\n.*Tangerine marmalade/) >= 1);
    before = pageRows(bookmarks, cache);
  } finally {
    await client.close();
  }
  const marmaladeEmbeds = embedded(log, /marmalade/i);
  const lighthouseEmbeds = embedded(log, /lighthouse/i);
  assert.ok(marmaladeEmbeds >= 1 && lighthouseEmbeds >= 1);

  // Both pages due again; the coast page's text changes, the kitchen page's does not.
  const db = new DatabaseSync(indexFile(bookmarks, cache));
  db.exec("UPDATE pages SET next_attempt_at = 0");
  db.close();
  pages["/coast"] = lighthouse("persimmon");

  client = await startServer({ bookmarks, cache, site, log });
  try {
    const data = await until(async () => {
      const d = await search(client, "persimmon orchard");
      return /persimmon/.test(d.results[0]?.snippet) && /pages 2\/2$/.test(d.status.progress) ? d : null;
    }, "the coast page's new text to be embedded");
    assert.equal(data.results[0].title, "Seaside reading");
    assert.match(data.results[0].snippet, /persimmon orchard/i);
    const after = pageRows(bookmarks, cache);
    const kitchen = site.url("/kitchen");
    assert.ok(after.get(kitchen).fetched_at > before.get(kitchen).fetched_at, "the kitchen page was fetched again");
    assert.equal(after.get(kitchen).content_hash, before.get(kitchen).content_hash);
    assert.equal(site.count("/kitchen"), 2);
    // The kitchen page was fetched before the coast page (newest first), so its
    // re-fetch was handled before the coast page's new chunks were embedded.
    assert.equal(embedded(log, /marmalade/i), marmaladeEmbeds, "the unchanged page is not embedded again");
    assert.ok(embedded(log, /persimmon/i) >= 1);
    assert.equal(embedded(log, /lighthouse/i), lighthouseEmbeds);
  } finally {
    await client.close();
    await site.close();
  }
});
