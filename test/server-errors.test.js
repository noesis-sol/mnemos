// Protocol-level E2E for the error paths: bad arguments, broken bookmarks
// files and unknown tools must come back as polite MCP results, never crash
// the server or corrupt the stream. Spawns the built server like server.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

async function startServer(bookmarksPath) {
  const client = new Client({ name: "mnemos-test-errors", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath, // current node binary — robust on Windows
      args: [path.join(ROOT, "dist", "index.js")],
      env: { ...process.env, CHROME_BOOKMARKS_PATH: bookmarksPath },
    }),
  );
  return client;
}

/** Start a server on a temp Bookmarks file holding `contents`, run `fn`, clean up. */
async function withBookmarksFile(contents, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-errors-"));
  const file = path.join(dir, "Bookmarks");
  await fs.writeFile(file, contents);
  const client = await startServer(file);
  try {
    await fn(client);
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

let client;

before(async () => {
  client = await startServer(FIXTURE);
});

after(async () => {
  await client.close();
});

test("e2e errors: search_bookmarks without query is isError", async () => {
  const result = await client.callTool({ name: "search_bookmarks", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query/);
});

test("e2e errors: list_folder_contents without folder is isError", async () => {
  const result = await client.callTool({ name: "list_folder_contents", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /folder/);
});

test("e2e errors: search_bookmarks with a numeric query is isError", async () => {
  const result = await client.callTool({ name: "search_bookmarks", arguments: { query: 5 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query/);
});

test("e2e errors: an empty query is a normal result carrying error, not isError", async () => {
  const result = await client.callTool({ name: "search_bookmarks", arguments: { query: "" } });
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0].text);
  assert.match(data.error, /Empty query/);
});

test("e2e errors: an unknown tool name is an error", async () => {
  // SDK 1.29 answers with an isError result; older 1.x versions reject the call.
  let result;
  try {
    result = await client.callTool({ name: "no_such_tool", arguments: {} });
  } catch (e) {
    assert.match(e.message, /no_such_tool/);
    return;
  }
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no_such_tool not found/);
});

test("e2e errors: the server still answers after the failed calls", async () => {
  const result = await client.callTool({ name: "list_folders", arguments: {} });
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.total_bookmarks, 16);
  const ai = data.folders.find((f) => f.folder === "Bookmarks Bar › AI");
  assert.deepEqual(ai, { folder: "Bookmarks Bar › AI", bookmarks: 2, subtree_bookmarks: 2 });
});

test("e2e errors: search_bookmarks with folder 'ai' returns only the two AI bookmarks", async () => {
  const result = await client.callTool({
    name: "search_bookmarks",
    arguments: { query: "https", folder: "ai" },
  });
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.total_matches, 2);
  assert.deepEqual(
    data.matches.map((m) => m.url).sort(),
    ["https://docs.anthropic.com/", "https://openai.com/"],
  );
});

test("e2e errors: a malformed-JSON bookmarks file is isError 'not valid JSON'", async () => {
  await withBookmarksFile('{"roots": {', async (broken) => {
    const result = await broken.callTool({ name: "list_folders", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not valid JSON/);
  });
});

test("e2e errors: a non-Chrome JSON file is isError 'not a Chrome Bookmarks file'", async () => {
  await withBookmarksFile(JSON.stringify({ name: "package", version: "1.0.0" }), async (broken) => {
    const result = await broken.callTool({
      name: "search_bookmarks",
      arguments: { query: "anything" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not a Chrome Bookmarks file/);
  });
});
