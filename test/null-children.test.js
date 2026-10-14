// A Bookmarks file with null (and other non-object) entries in its children
// arrays (GitHub #2): every tool skips them instead of failing the whole call
// with "Cannot read properties of null". In process (dist/lib.js) for the
// keyword tools, and over MCP (the built server, spawned and driven with the
// SDK's client, MNEMOS_EMBEDDER=fake in a temporary MNEMOS_CACHE_DIR) for all
// six tools, semantic_search's title index included.
// node:test runs each test file in its own process, so mutating process.env
// here cannot leak into other test files.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as lib from "../dist/lib.js";

const { SEP } = lib;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const dirs = [];
// Every test closes its clients first; a directory that will not go is let be.
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

const url = (name) => ({
  type: "url",
  name,
  url: `https://${name}.example/`,
  date_added: "13349793600000000",
});
const folder = (name, children) => ({ type: "folder", name, children });

// Nulls first, last, between siblings and alone in a folder, with a bare
// string and number for good measure: none of them is a bookmark node.
const ROOTS = {
  bookmark_bar: folder("", [
    null,
    url("alpha"),
    null,
    folder("Nested", [null, url("beta"), "stray", 42, null]),
    folder("Hollow", [null]),
    url("gamma"),
    null,
  ]),
  other: folder("", [null]),
};

/** Write ROOTS to a fresh Bookmarks file; returns its scratch directory and path. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-null-children-"));
  dirs.push(dir);
  const bookmarks = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarks, JSON.stringify({ roots: ROOTS }));
  return { dir, bookmarks };
}

const NAMES = ["alpha", "beta", "gamma"];
const FOLDERS = [
  "Bookmarks Bar",
  `Bookmarks Bar${SEP}Hollow`,
  `Bookmarks Bar${SEP}Nested`,
  "Other Bookmarks",
];

// --- in process ----------------------------------------------------------------

test("null children: the walk skips them and keeps every real bookmark in order", () => {
  process.env.CHROME_BOOKMARKS_PATH = scratch().bookmarks;
  const entries = [...lib.allBookmarks()];
  assert.deepEqual(
    entries.map((e) => [e.folder, e.node.name]),
    [
      ["Bookmarks Bar", "alpha"],
      [`Bookmarks Bar${SEP}Nested`, "beta"],
      ["Bookmarks Bar", "gamma"],
    ],
  );
});

test("null children: every keyword tool succeeds and skips them", () => {
  process.env.CHROME_BOOKMARKS_PATH = scratch().bookmarks;

  const search = lib.searchBookmarks("beta");
  assert.equal(search.total_matches, 1);
  assert.equal(search.matches[0].url, "https://beta.example/");
  assert.equal(lib.searchBookmarks("example").total_matches, 3);

  const folders = lib.listFolders();
  assert.deepEqual(folders.folders.map((f) => f.folder).sort(), [...FOLDERS].sort());
  const hollow = folders.folders.find((f) => f.folder === `Bookmarks Bar${SEP}Hollow`);
  assert.equal(hollow.bookmarks, 0);

  assert.deepEqual(
    lib.listFolderContents("Nested").bookmarks.map((b) => b.title),
    ["beta"],
  );
  assert.equal(lib.recentBookmarks().total_matches, 3);
  assert.deepEqual(
    lib.topDomains().domains.map((d) => d.domain).sort(),
    NAMES.map((n) => `${n}.example`),
  );
});

// --- over MCP ------------------------------------------------------------------

test("null children e2e: all six tools answer over MCP without an error", async () => {
  const s = scratch();
  const client = new Client({ name: "mnemos-null-children", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: s.bookmarks,
        MNEMOS_CACHE_DIR: path.join(s.dir, "cache"),
        MNEMOS_EMBEDDER: "fake",
        // No page fetching: nothing at *.example to fetch.
        MNEMOS_FETCH_PAGES: "0",
      },
      stderr: "ignore",
    }),
  );
  try {
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text);
    };

    assert.equal((await call("search_bookmarks", { query: "example" })).total_matches, 3);
    assert.deepEqual(
      (await call("list_folders")).folders.map((f) => f.folder).sort(),
      [...FOLDERS].sort(),
    );
    assert.equal((await call("list_folder_contents", { folder: "Nested" })).total_matches, 1);
    assert.equal((await call("recent_bookmarks")).total_matches, 3);
    assert.equal((await call("top_domains")).total_matches, 3);

    // semantic_search answers at once (keyword fallback while indexing); wait
    // for the title index too, which reads the same tree.
    const deadline = Date.now() + 15_000;
    let data;
    for (;;) {
      data = await call("semantic_search", { query: "beta" });
      if (data.status.indexing === "ready" && data.status.search === "semantic") break;
      if (Date.now() > deadline) assert.fail(`titles not indexed in time: ${JSON.stringify(data.status)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      data.results.some((r) => r.url === "https://beta.example/"),
      JSON.stringify(data.results),
    );
  } finally {
    await client.close();
  }
});
