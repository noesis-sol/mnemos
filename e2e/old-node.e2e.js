// The bin on a Node older than mnemos supports, for real: CI's old-node job
// runs this file on Node 18 and 20 (`node --test e2e/old-node.e2e.js`, after
// building), where the server itself cannot even load (node:sqlite does not
// exist), so it uses nothing newer than Node 18's node:test. The
// bin must still complete the MCP handshake and answer with the explanation,
// so the user hears it from the assistant instead of seeing "failed to
// connect". Its name keeps it out of the discovery `npm test` does; on a
// supported Node it skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const [major, minor] = process.versions.node.split(".").map(Number);
const old = major < 22 || (major === 22 && minor < 13);

test(`old Node: the bin connects and explains (running Node ${process.versions.node})`, { skip: !old && "this Node is supported" }, async () => {
  const client = new Client({ name: "mnemos-old-node-e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, pkg.bin["mnemos-mcp"])],
      env: { ...process.env, MNEMOS_FETCH_PAGES: "0" },
      stderr: "pipe",
    }),
  );
  try {
    const instructions = client.getInstructions();
    assert.match(instructions, new RegExp(`runs Node\\.js ${process.versions.node.replace(/\./g, "\\.")}`));
    assert.match(instructions, /mnemos-mcp@0\.3/);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "search_bookmarks"), tools.map((t) => t.name).join(", "));
    const result = await client.callTool({ name: "search_bookmarks", arguments: { query: "rust" } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, instructions);
  } finally {
    await client.close();
  }
});
