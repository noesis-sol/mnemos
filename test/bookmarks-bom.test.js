// A Bookmarks file saved by a Windows editor starts with a UTF-8 byte order
// mark. JSON.parse rejected it, and the error blamed Chrome for being
// mid-write (GitHub #5): the file must read as if the mark were not there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as lib from "../dist/lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-bom-"));
// The fixture with a byte order mark in front, written here so no editor or
// checkout can strip the mark from a committed copy.
const BOM_FIXTURE = path.join(DIR, "Bookmarks");
fs.writeFileSync(BOM_FIXTURE, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(FIXTURE)]));
const CACHE = path.join(DIR, "cache");

after(() => {
  try {
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // a temporary directory left behind
  }
});

/** What `fn` returns with CHROME_BOOKMARKS_PATH set to `file`. */
function readWith(file, fn) {
  process.env.CHROME_BOOKMARKS_PATH = file;
  return fn();
}

const TOOLS = {
  search_bookmarks: () => lib.searchBookmarks("https", undefined, 200),
  list_folders: () => lib.listFolders(),
  list_folder_contents: () => lib.listFolderContents("AI", 200),
  recent_bookmarks: () => lib.recentBookmarks(200),
  top_domains: () => lib.topDomains(200),
};

test("bom: the fixture written with a byte order mark starts with one", () => {
  assert.deepEqual([...fs.readFileSync(BOM_FIXTURE).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

for (const [name, fn] of Object.entries(TOOLS)) {
  test(`bom: ${name} returns the same bookmarks as without the mark`, () => {
    // Each result names the file it read; the rest must be the same.
    const { sources: plainSources, ...plain } = readWith(FIXTURE, fn);
    const { sources: markedSources, ...marked } = readWith(BOM_FIXTURE, fn);
    assert.equal(marked.error, undefined);
    assert.deepEqual(marked, plain);
    assert.deepEqual(markedSources, [{ browser: "chrome", profile: null, bookmarks: BOM_FIXTURE }]);
    assert.deepEqual(plainSources, [{ browser: "chrome", profile: null, bookmarks: FIXTURE }]);
  });
}

test("bom: the bookmarks under the mark are all read", () => {
  const plain = readWith(FIXTURE, () => [...lib.allBookmarks()].map((e) => e.url));
  assert.ok(plain.length > 0);
  assert.deepEqual(
    readWith(BOM_FIXTURE, () => [...lib.allBookmarks()].map((e) => e.url)),
    plain,
  );
});

test("bom: malformed JSON without a mark still gets the mid-write message", () => {
  const bad = path.join(DIR, "Malformed");
  fs.writeFileSync(bad, "{ not json");
  assert.throws(() => readWith(bad, () => lib.listFolders()), /not valid JSON.*mid-write/s);
});

test("bom: malformed JSON after a mark gets the mid-write message too", () => {
  const bad = path.join(DIR, "MalformedWithMark");
  fs.writeFileSync(bad, "﻿{ not json");
  assert.throws(() => readWith(bad, () => lib.listFolders()), /not valid JSON.*mid-write/s);
});

// --- over MCP: every tool -----------------------------------------------------

test("e2e bom: every tool answers from the marked file", async () => {
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        MNEMOS_CACHE_DIR: CACHE,
        MNEMOS_EMBEDDER: "fake",
        MNEMOS_FETCH_PAGES: "0",
        MNEMOS_BOOKMARKS_BROWSER: "",
        CHROME_BOOKMARKS_PATH: BOM_FIXTURE,
      },
    }),
  );
  try {
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text);
    };
    assert.ok((await call("search_bookmarks", { query: "openai" })).total_matches > 0);
    assert.ok((await call("list_folders", {})).folders.length > 0);
    assert.ok((await call("list_folder_contents", { folder: "AI" })).bookmarks.length > 0);
    assert.ok((await call("recent_bookmarks", {})).bookmarks.length > 0);
    assert.ok((await call("top_domains", {})).domains.length > 0);
    // semantic_search answers once the titles are indexed.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const data = await call("semantic_search", { query: "openai" });
      if (data.status.indexing === "ready" && data.status.search === "semantic") {
        assert.ok(data.results.length > 0);
        break;
      }
      if (Date.now() > deadline) assert.fail(`titles not indexed in time: ${JSON.stringify(data.status)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await client.close();
  }
});
