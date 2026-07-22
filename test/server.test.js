// Protocol-level E2E: spawn the built server as a child process and drive it
// with the MCP SDK's own client over stdio. This catches wiring bugs the unit
// tests cannot — a broken shebang/bin, schemas the SDK rejects, or stray
// output on stdout corrupting the protocol.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

let client;

before(async () => {
  client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath, // current node binary — robust on Windows
      args: [path.join(ROOT, "dist", "index.js")],
      env: { ...process.env, CHROME_BOOKMARKS_PATH: FIXTURE },
    }),
  );
});

after(async () => {
  await client.close();
});

test("e2e: handshake exposes all five tools with schemas", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["list_folder_contents", "list_folders", "recent_bookmarks", "search_bookmarks", "top_domains"],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("e2e: tool call round-trips against the fixture", async () => {
  const result = await client.callTool({
    name: "search_bookmarks",
    arguments: { query: "openai" },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.total_matches, 1);
  assert.equal(data.matches[0].url, "https://openai.com/");
});

test("e2e: filesystem failure surfaces as isError, not a crash", async () => {
  // A second server pointed at a nonexistent file must still answer politely.
  const broken = new Client({ name: "mnemos-test-broken", version: "0.0.0" });
  await broken.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: { ...process.env, CHROME_BOOKMARKS_PATH: path.join(ROOT, "nope", "Bookmarks") },
    }),
  );
  try {
    const result = await broken.callTool({ name: "list_folders", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No bookmarks file/);
  } finally {
    await broken.close();
  }
});
