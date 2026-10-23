// semantic_search following edits to the Bookmarks file while the server runs.
// Over MCP (the built server, spawned and driven with the SDK's client,
// MNEMOS_EMBEDDER=fake in a temporary MNEMOS_CACHE_DIR, on a copy of the
// fixture): each semantic_search calls the indexer's checkForChanges(), so once
// the titles are indexed, a bookmark added to the file is found by its title,
// a renamed one by its new title and not its old, and a deleted one is gone.
//
// Keyword hits come from the file on every call, so they would pass with no
// re-index at all. The queries here are a title word and one the bookmark does
// not have: no keyword hit, so a result is matched_on "title", from a vector
// the index stored for the edited file.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-semantic-live-"));
const bookmarks = path.join(dir, "Bookmarks");
fs.copyFileSync(FIXTURE, bookmarks);
let client;

after(async () => {
  await client?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // a temporary directory left behind
  }
});

/** The bookmarks of the file, as lib reads them. */
function count() {
  const saved = process.env.CHROME_BOOKMARKS_PATH;
  process.env.CHROME_BOOKMARKS_PATH = bookmarks;
  try {
    return [...lib.allBookmarks()].length;
  } finally {
    if (saved === undefined) delete process.env.CHROME_BOOKMARKS_PATH;
    else process.env.CHROME_BOOKMARKS_PATH = saved;
  }
}

/** Rewrites the Bookmarks file with `edit` applied to its bookmark bar's children. */
function editBar(edit) {
  const data = JSON.parse(fs.readFileSync(bookmarks, "utf8"));
  edit(data.roots.bookmark_bar.children);
  fs.writeFileSync(bookmarks, JSON.stringify(data));
}

async function search(query) {
  const result = await client.callTool({ name: "semantic_search", arguments: { query } });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

/**
 * semantic_search's answer once its titles are all indexed and `check` holds
 * for it; each call is also what makes the server look at the file again.
 */
async function searchUntil(query, check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await search(query);
    const total = count();
    if (data.status.indexing === "ready" && data.status.progress.startsWith(`titles ${total}/${total} `) && check(data)) {
      return data;
    }
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(data)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const byUrl = (data, url) => data.results.find((r) => r.url === url);

test("e2e: once indexed, the fixture's titles are found semantically", async () => {
  client = new Client({ name: "mnemos-semantic-live", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: bookmarks,
        MNEMOS_CACHE_DIR: path.join(dir, "cache"),
        MNEMOS_EMBEDDER: "fake",
        // No page fetching: the fixture's URLs are real sites.
        MNEMOS_FETCH_PAGES: "0",
      },
      stderr: "ignore",
    }),
  );
  const data = await searchUntil("gmail inbox", (d) => d.status.search === "semantic", "the titles to be indexed");
  const gmail = byUrl(data, "https://mail.google.com/");
  assert.equal(gmail?.title, "Gmail");
  assert.equal(gmail.matched_on, "title", "no keyword hit: inbox is no word of it");
});

test("e2e: a bookmark added while the server runs is found by its title", async () => {
  const url = "https://example.org/zettelkasten";
  editBar((bar) => bar.push({ type: "url", name: "Zettelkasten method", url }));
  const data = await searchUntil("zettelkasten notes", (d) => byUrl(d, url), "the added bookmark");
  const added = byUrl(data, url);
  assert.equal(added.title, "Zettelkasten method");
  assert.equal(added.matched_on, "title");
  assert.ok(added.score > 0);
});

test("e2e: a bookmark renamed while the server runs is found by its new title, not its old", async () => {
  const url = "https://mail.google.com/";
  editBar((bar) => {
    bar.find((n) => n.name === "Gmail").name = "Proton mailbox";
  });
  const data = await searchUntil("proton account", (d) => byUrl(d, url), "the renamed bookmark");
  const renamed = byUrl(data, url);
  assert.equal(renamed.title, "Proton mailbox");
  assert.equal(renamed.matched_on, "title");
  // The same run re-embedded it: its old title's vector is gone.
  assert.equal(byUrl(await search("gmail inbox"), url), undefined, "not found by its old title");
});

test("e2e: a bookmark deleted while the server runs is gone from the results", async () => {
  const url = "https://example.com/watercolor";
  const before = await search("watercolor lessons");
  assert.equal(byUrl(before, url)?.matched_on, "title", "found before it is deleted");

  editBar((bar) => {
    const painting = bar.find((n) => n.name === "Painting");
    painting.children = painting.children.filter((n) => n.url !== url);
  });
  // searchUntil waits for the index to count one title fewer.
  const data = await searchUntil("watercolor lessons", () => true, "the deleted bookmark's row to go");
  assert.equal(byUrl(data, url), undefined);
  assert.equal(byUrl(await search("watercolor"), url), undefined, "nor as a keyword hit");
  assert.equal(byUrl(await search("aquarelle"), url), undefined, "nor by a synonym");
});
