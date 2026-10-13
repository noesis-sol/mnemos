// Other browsers over MCP: the built server, spawned and driven with the SDK's
// client, reads a Safari Bookmarks.plist through CHROME_BOOKMARKS_PATH and
// returns descriptions over the wire; an unknown MNEMOS_BOOKMARKS_BROWSER
// comes back as isError.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAFARI_FIXTURE = path.join(ROOT, "test", "fixtures", "safari-bookmarks.plist");

// Index in a scratch cache with the fake embedder: never the user's cache, never the real model.
const CACHE = mkdtempSync(path.join(os.tmpdir(), "mnemos-cache-"));
const INDEX_ENV = { MNEMOS_CACHE_DIR: CACHE, MNEMOS_EMBEDDER: "fake" };
// Each test closes its client, which waits for the server to exit, before this runs. A
// throwing after hook would skip the hooks after it, so a leftover directory is let be.
after(() => {
  try {
    rmSync(CACHE, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // a temporary directory left behind
  }
});

async function withServer(env, fn) {
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: { ...process.env, ...INDEX_ENV, CHROME_BOOKMARKS_PATH: "", MNEMOS_BOOKMARKS_BROWSER: "", TZ: "UTC", ...env },
    }),
  );
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("e2e browsers: a Safari Bookmarks.plist is searched, description included", async () => {
  await withServer({ CHROME_BOOKMARKS_PATH: SAFARI_FIXTURE }, async (client) => {
    const result = await client.callTool({ name: "search_bookmarks", arguments: { query: "coastal" } });
    assert.ok(!result.isError, result.content[0].text);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total_matches, 1);
    assert.deepEqual(data.matches[0], {
      title: "Tidepools",
      url: "https://example.org/tidepools",
      folder: "Reading List",
      added: "2024-05-01",
      description: "Why tidepools matter for coastal ecology.",
    });
  });
});

test("e2e browsers: an unknown MNEMOS_BOOKMARKS_BROWSER is isError", async () => {
  await withServer({ MNEMOS_BOOKMARKS_BROWSER: "netscape" }, async (client) => {
    const result = await client.callTool({ name: "list_folders", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /MNEMOS_BOOKMARKS_BROWSER is "netscape"/);
  });
});
