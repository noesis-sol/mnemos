// semantic_search. Over MCP (the built server, spawned and driven with the
// SDK's client, MNEMOS_EMBEDDER=fake in a temporary MNEMOS_CACHE_DIR, on a copy
// of the fixture with a Reading folder added): ranking by fake-similar words,
// the keyword boost, the cutoff, the folder filter, limit and cap, and the
// keyword fallback while titles are not indexed or the embedder is
// unavailable. In process (dist/semantic.js): a page chunk beating the title.
//
// The real model's cutoff (MODEL_RELEVANCE in src/embedder.ts) was calibrated
// by hand on 2026-10-13 against a real library of 2,300 bookmarks (14% Greek),
// keeping what scored max(0.8, median + 0.065, best - 0.04):
//   related, kept:    "sculpture" (14, all from the Sculpture folder),
//                     "coffee beans" (18), "espresso" (3), "poems" (17),
//                     "ποίηση" (18, Greek and English poems),
//                     "vaccine side effects" (18), "typescript ORM tutorial" (20),
//                     "ancient greek philosophy" (34), "αρχαία ελληνική φιλοσοφία" (39),
//                     "audiobooks to listen to" (49), "ταβέρνες στην Αθήνα" (26),
//                     "guitar chords" (1)
//   unrelated, none:  "sourdough bread recipe" (best 0.823),
//                     "quantum chromodynamics lattice" (0.832), "tax return form" (0.839)
// A fixed floor alone failed both ways: 0.80 kept 80-360 unrelated titles, and
// 0.84 kept 1 for the Greek philosophy query, whose scores all sit lower.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EmbedderUnavailableError, FAKE_RELEVANCE, FakeEmbedder, createEmbedder, fakeVector } from "../dist/embedder.js";
import { IndexStore, dot } from "../dist/index-store.js";
import { Indexer, embeddingText } from "../dist/indexer.js";
import { QUERY_EMBED_TIMEOUT_MS, SNIPPET_CHARS, semanticSearch, snippet } from "../dist/semantic.js";
import * as lib from "../dist/lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

const dirs = [];
// Every test closes its clients and indexers first; a directory that will not go is let be.
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

const READING = [
  // Matches "rust crab" word for word (at word starts), but shares no whole word with it.
  { type: "url", name: "Rustacean crabs", url: "https://example.org/shelf" },
  // Shares "rust" with "rust crab", and has no "crab".
  { type: "url", name: "Rust in action", url: "https://example.org/rust-in-action" },
];

/** A cache directory, a gate file, and a Bookmarks file: the fixture plus a Reading folder, or `data`. */
function scratch(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-semantic-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  if (!data) {
    data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    data.roots.bookmark_bar.children.push({ type: "folder", name: "Reading", children: READING });
  }
  fs.writeFileSync(bookmarks, JSON.stringify(data));
  return { dir, bookmarks, cache: path.join(dir, "cache"), gate: path.join(dir, "gate") };
}

async function startServer(s, env = {}) {
  const client = new Client({ name: "mnemos-semantic", version: "0.0.0" });
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
        // No page fetching: the fixture's URLs are real sites (page-fetcher.test.js fetches).
        MNEMOS_FETCH_PAGES: "0",
        ...env,
      },
      stderr: "ignore",
    }),
  );
  return client;
}

async function search(client, args) {
  const result = await client.callTool({ name: "semantic_search", arguments: args });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

/** semantic_search's answer once the titles are indexed. */
async function searchWhenIndexed(client, args, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await search(client, args);
    if (data.status.indexing === "ready" && data.status.search === "semantic") return data;
    if (Date.now() > deadline) assert.fail(`titles not indexed in time: ${JSON.stringify(data.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

/** The fake embedder's score for each bookmark of `file`, by title. */
function fakeScores(file, query) {
  const q = fakeVector(query);
  return new Map(
    entriesOf(file).map((e) => [
      e.node.name,
      dot(q, fakeVector(embeddingText({ title: e.node.name ?? "", folder_path: e.folder, url: e.node.url ?? "" }))),
    ]),
  );
}

const titles = (data) => data.results.map((r) => r.title);

// --- over MCP: one server, its embedder held back at first -------------------

const served = scratch();
const servedCount = entriesOf(served.bookmarks).length;
const servedPages = new Set(
  entriesOf(served.bookmarks)
    .map((e) => e.node.url)
    .filter((url) => /^https?:/.test(url)),
).size;
let client;

test("e2e: tools/list has semantic_search, described, with query, folder and limit", async () => {
  client = await startServer(served);
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "semantic_search");
  assert.ok(tool, "semantic_search is listed");
  assert.match(tool.description, /meaning/);
  assert.match(tool.description, /count_above_threshold/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["folder", "limit", "query"]);
  assert.deepEqual(tool.inputSchema.required, ["query"]);
  assert.match(client.getInstructions(), /semantic_search/);
});

test("e2e: before the titles are indexed, keyword hits, and the status says so", async () => {
  // The gate file does not exist yet, so the fake embedder holds every embed() up.
  const started = Date.now();
  const data = await search(client, { query: "openai" });
  assert.ok(Date.now() - started >= QUERY_EMBED_TIMEOUT_MS - 100, "waited for the query's vector, then gave up");
  assert.deepEqual(titles(data), ["OpenAI"]);
  assert.equal(data.results[0].matched_on, "keyword");
  assert.equal(data.results[0].score, null);
  assert.equal(data.results[0].url, "https://openai.com/");
  assert.equal(data.results[0].folder, "Bookmarks Bar › AI");
  assert.equal(data.count_above_threshold, 1);
  assert.equal(data.status.search, "keyword");
  assert.equal(data.status.indexing, "indexing");
  assert.equal(data.status.embedder, "ready");
  assert.equal(data.status.fetching_disabled, true);
  assert.equal(data.status.fetching, "disabled");
  assert.equal(data.status.progress, `titles 0/${servedCount} · pages 0/${servedPages}`);
  assert.match(data.status.note, /^Keyword matches only/);
  assert.match(data.status.note, /did not answer/);

  // No exact word, no keyword hit: nothing yet.
  const none = await search(client, { query: "poems" });
  assert.deepEqual(none.results, []);
  assert.equal(none.count_above_threshold, 0);
  assert.match(none.note, /No bookmarks match "poems"/);
});

test("e2e: once indexed, a query sharing no exact word finds the bookmark by fake-similar words", async () => {
  fs.writeFileSync(served.gate, "");
  const poems = await searchWhenIndexed(client, { query: "poems" });
  assert.equal(poems.results[0].title, "Καβάφης — Ποιήματα");
  assert.equal(poems.results[0].matched_on, "title");
  assert.ok(poems.results[0].score > FAKE_RELEVANCE.floor);
  assert.equal(poems.results[0].snippet, undefined, "no page, no snippet");
  assert.equal(poems.status.progress, `titles ${servedCount}/${servedCount} · pages 0/${servedPages}`);
  assert.equal(poems.status.note, undefined);

  const aquarelle = await search(client, { query: "aquarelle" });
  assert.equal(aquarelle.results[0].title, "Watercolor basics");
  assert.equal(aquarelle.results[0].matched_on, "title");
  // The same question to search_bookmarks finds nothing.
  const exact = await client.callTool({ name: "search_bookmarks", arguments: { query: "aquarelle" } });
  assert.equal(JSON.parse(exact.content[0].text).total_matches, 0);
});

test("e2e: an exact keyword hit outranks a closer-scoring non-keyword hit", async () => {
  const scores = fakeScores(served.bookmarks, "rust crab");
  assert.ok(scores.get("Rust in action") > scores.get("Rustacean crabs"), "precondition: the non-keyword hit scores higher");

  const data = await search(client, { query: "rust crab" });
  assert.deepEqual(titles(data), ["Rustacean crabs", "Rust in action"]);
  assert.equal(data.results[0].matched_on, "keyword");
  assert.equal(data.results[1].matched_on, "title");
  assert.ok(data.results[0].score < data.results[1].score);
  assert.equal(data.results[1].score, Math.round(scores.get("Rust in action") * 1000) / 1000, "score rounded");
  assert.equal(data.count_above_threshold, 2);
});

test("e2e: results below the cutoff are left out", async () => {
  const scores = fakeScores(served.bookmarks, "arxiv openai models");
  const attention = scores.get("Attention is all you need");
  assert.ok(attention > 0 && attention < FAKE_RELEVANCE.floor, `precondition: related, but under the floor (${attention})`);
  assert.ok(scores.get("OpenAI") >= FAKE_RELEVANCE.floor);

  const data = await search(client, { query: "arxiv openai models" });
  assert.deepEqual(titles(data), ["OpenAI"]);
  assert.equal(data.count_above_threshold, 1);

  const unrelated = await search(client, { query: "zeppelin" });
  assert.deepEqual(unrelated.results, []);
  assert.match(unrelated.note, /Nothing relates closely to "zeppelin"\.$/);
});

test("e2e: the folder filter, as the other tools match folders", async () => {
  const greek = await search(client, { query: "poems", folder: "ελληνική" });
  assert.deepEqual(titles(greek), ["Καβάφης — Ποιήματα"]);

  const elsewhere = await search(client, { query: "poems", folder: "Painting" });
  assert.deepEqual(elsewhere.results, []);
  assert.match(elsewhere.note, /in folders matching "Painting"/);
  assert.match(elsewhere.note, /list_folders/);

  const reading = await search(client, { query: "rust crab", folder: "reading" });
  assert.deepEqual(titles(reading), ["Rustacean crabs", "Rust in action"]);
  const ai = await search(client, { query: "rust crab", folder: "AI" });
  assert.deepEqual(ai.results, [], "keyword hits are filtered too");

  const blank = await search(client, { query: "poems", folder: "  " });
  assert.equal(blank.results[0].title, "Καβάφης — Ποιήματα", "a blank folder is no filter");
});

test("e2e: an empty query is an error to the caller, not a crash", async () => {
  const data = await search(client, { query: "   " });
  assert.match(data.error, /Empty query/);
  const missing = await client.callTool({ name: "semantic_search", arguments: {} });
  assert.equal(missing.isError, true);
  await client.close();
});

// --- over MCP: limit and cap -------------------------------------------------

test("e2e: limit defaults to 20 and is capped at 100; count_above_threshold counts them all", async () => {
  const note = (n) => ({ type: "url", name: `Note ${n}`, url: `https://notes.example/${n}` });
  const folder = (name, from) => ({
    type: "folder",
    name,
    children: Array.from({ length: 75 }, (_, i) => note(from + i)),
  });
  const s = scratch({
    roots: {
      bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [folder("Alpha", 0), folder("Beta", 75)] },
      other: { type: "folder", name: "Other bookmarks", children: [] },
    },
  });
  fs.writeFileSync(s.gate, "");
  const notes = await startServer(s);
  try {
    const all = await searchWhenIndexed(notes, { query: "note" });
    assert.equal(all.count_above_threshold, 150);
    assert.equal(all.results.length, 20);
    assert.equal((await search(notes, { query: "note", limit: 5 })).results.length, 5);
    assert.equal((await search(notes, { query: "note", limit: 1000 })).results.length, 100);
    assert.equal((await search(notes, { query: "note", limit: 0 })).results.length, 0);
    const alpha = await search(notes, { query: "note", folder: "alpha", limit: 100 });
    assert.equal(alpha.count_above_threshold, 75);
    assert.ok(alpha.results.every((r) => r.folder === "Bookmarks Bar › Alpha"));
    const bad = await notes.callTool({ name: "semantic_search", arguments: { query: "note", limit: 2.5 } });
    assert.equal(bad.isError, true);
  } finally {
    await notes.close();
  }
});

// --- over MCP: the embedder unavailable ---------------------------------------

test("e2e: with the embedder unavailable, keyword hits and the reason; fetching disabled is reported", async () => {
  const s = scratch();
  const unavailable = await startServer(s, {
    MNEMOS_FAKE_EMBED_UNAVAILABLE: "simulated: the runtime is not installed",
    MNEMOS_FETCH_PAGES: "0",
  });
  try {
    const data = await search(unavailable, { query: "rust crab" });
    assert.deepEqual(titles(data), ["Rustacean crabs"]);
    assert.equal(data.results[0].matched_on, "keyword");
    assert.equal(data.status.search, "keyword");
    assert.equal(data.status.embedder, "unavailable");
    assert.equal(data.status.fetching_disabled, true);
    assert.match(data.status.note, /^Keyword matches only/);
    assert.match(data.status.note, /simulated: the runtime is not installed/);
    assert.match(data.status.progress, /^titles 0\/\d+ · pages 0\/\d+$/);
  } finally {
    await unavailable.close();
  }
});

// --- in process --------------------------------------------------------------

test("semantic search: a page chunk that beats the title is matched_on page, with a trimmed snippet", async () => {
  const s = scratch();
  const embedder = new FakeEmbedder();
  const indexer = new Indexer({
    embedder,
    bookmarksFile: () => s.bookmarks,
    entries: () => entriesOf(s.bookmarks),
    dir: s.cache,
  });
  indexer.start();
  await indexer.idle();

  const url = "https://example.com/watercolor";
  // Longer than a snippet, and about the query only (the fake counts every word).
  const text = "Sourdough starter, fed daily. ".repeat(12);
  const store = IndexStore.open({ bookmarksFile: s.bookmarks, dir: s.cache });
  store.replaceChunks(url, ["Brushes and paper for beginners.", text]);
  store.setChunkVector(url, 0, "Brushes and paper for beginners.", fakeVector("Brushes and paper for beginners."));
  store.setChunkVector(url, 1, text, fakeVector(text));
  store.close();

  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = s.bookmarks;
  try {
    const data = await semanticSearch({ embedder, indexer, env: {} }, "sourdough starter");
    const hit = data.results[0];
    assert.equal(hit.title, "Watercolor basics");
    assert.equal(hit.matched_on, "page");
    assert.ok(hit.snippet.startsWith("Sourdough starter, fed daily. Sourdough"));
    assert.ok(hit.snippet.endsWith("…"));
    assert.ok(hit.snippet.length <= SNIPPET_CHARS + 1);
    assert.match(data.status.progress, / · pages 1\/\d+$/);

    // The title wins where it is closer: matched_on title, no snippet.
    const title = await semanticSearch({ embedder, indexer, env: {} }, "aquarelle");
    assert.equal(title.results[0].matched_on, "title");
    assert.equal(title.results[0].snippet, undefined);
  } finally {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
    indexer.close();
  }
});

test("snippet: whitespace collapsed, short text whole, long text cut at a word", () => {
  assert.equal(snippet("  a\n\nb\tc  "), "a b c");
  const long = "word ".repeat(100);
  const cut = snippet(long);
  assert.ok(cut.length <= SNIPPET_CHARS + 1);
  assert.match(cut, /word…$/);
  assert.equal(snippet("x".repeat(400)), `${"x".repeat(SNIPPET_CHARS)}…`, "no space: a hard cut");
});

test("fake embedder: its synonyms score as the same word; `unavailable` plays a missing model", async () => {
  assert.deepEqual(fakeVector("aquarelle"), fakeVector("watercolor"));
  assert.deepEqual(fakeVector("Poems"), fakeVector("ποιήματα"));
  assert.equal(dot(fakeVector("constructor"), fakeVector("toString")), 0, "object keys are plain words");

  const fake = createEmbedder({ MNEMOS_EMBEDDER: "fake", MNEMOS_FAKE_EMBED_UNAVAILABLE: "no runtime" });
  assert.deepEqual(fake.status(), { state: "unavailable", reason: "no runtime" });
  await assert.rejects(fake.embed(["x"], "query"), EmbedderUnavailableError);
});

test("semantic search: the cutoff is also relative, to the median title and to the best hit", async () => {
  const s = scratch();
  const fake = new FakeEmbedder();
  const indexer = new Indexer({
    embedder: fake,
    bookmarksFile: () => s.bookmarks,
    entries: () => entriesOf(s.bookmarks),
    dir: s.cache,
  });
  indexer.start();
  await indexer.idle();
  // OpenAI scores about 0.44 and Attention about 0.16; the median title, 0.
  const kept = async (relevance) => {
    const embedder = {
      ...{ id: fake.id, revision: fake.revision, dim: fake.dim, relevance },
      status: () => fake.status(),
      embed: (texts, kind) => fake.embed(texts, kind),
    };
    const data = await semanticSearch({ embedder, indexer, env: {} }, "arxiv openai models");
    return titles(data);
  };
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = s.bookmarks;
  try {
    assert.deepEqual(await kept({ floor: 0.01, margin: 0, window: 1 }), ["OpenAI", "Attention is all you need"]);
    assert.deepEqual(await kept({ floor: 0.01, margin: 0.3, window: 1 }), ["OpenAI"], "median + margin");
    assert.deepEqual(await kept({ floor: 0.01, margin: 0, window: 0.3 }), ["OpenAI", "Attention is all you need"]);
    assert.deepEqual(await kept({ floor: 0.01, margin: 0, window: 0.2 }), ["OpenAI"], "best - window");
  } finally {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
    indexer.close();
  }
});
