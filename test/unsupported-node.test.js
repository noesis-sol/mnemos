// The Node check in front of the server: supportsNode() against MIN_NODE, the
// bin pointing at cli.js, and the explaining server an old Node gets
// (unsupported-node.ts), driven here on the current Node with a faked old
// version: it completes the handshake, says why and what to do in its
// instructions and in every tool's error, and offers the real server's tools.
// e2e/old-node.e2e.js runs the bin itself on a real old Node in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MIN_NODE, supportsNode } from "../dist/node-version.js";
import { TOOL_NAMES, unsupportedNodeMessage } from "../dist/unsupported-node.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

async function connect(args, env = {}) {
  const client = new Client({ name: "mnemos-test-old-node", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args, env: { ...process.env, ...env }, stderr: "pipe" }),
  );
  return client;
}

test("supportsNode: 22.13.0 and later pass, anything older fails", () => {
  for (const version of ["22.13.0", "22.13.1", "22.20.0", "23.0.0", "24.14.0", "30.1.2"]) {
    assert.equal(supportsNode(version), true, version);
  }
  for (const version of ["22.12.0", "22.0.0", "20.17.0", "18.20.4", "16.0.0"]) {
    assert.equal(supportsNode(version), false, version);
  }
});

test("MIN_NODE matches package.json's engines field", () => {
  assert.equal(pkg.engines.node, `>=${MIN_NODE.replace(/\.0$/, "")}`);
});

test("the bin is the Node check, not the server itself", () => {
  assert.deepEqual(pkg.bin, { "mnemos-mcp": "dist/cli.js" });
  assert.equal(readFileSync(path.join(ROOT, "dist", "cli.js"), "utf8").split("\n")[0].trimEnd(), "#!/usr/bin/env node");
});

test("the message names both versions and both ways out", () => {
  const message = unsupportedNodeMessage("20.17.0");
  assert.match(message, new RegExp(`mnemos ${pkg.version.replace(/\./g, "\\.")} needs Node\\.js ${MIN_NODE}`));
  assert.match(message, /runs Node\.js 20\.17\.0/);
  assert.match(message, /upgrade Node\.js/);
  assert.match(message, /mnemos-mcp@0\.3/);
});

test("e2e: on an old Node, mnemos connects and every tool explains why it cannot run", async () => {
  const module = pathToFileURL(path.join(ROOT, "dist", "unsupported-node.js")).href;
  const client = await connect([
    "--input-type=module",
    "-e",
    `const { serveUnsupportedNode } = await import(${JSON.stringify(module)}); await serveUnsupportedNode("20.17.0");`,
  ]);
  try {
    const message = unsupportedNodeMessage("20.17.0");
    assert.equal(client.getServerVersion().name, "mnemos");
    assert.equal(client.getServerVersion().version, pkg.version);
    assert.equal(client.getInstructions(), message);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
      const result = await client.callTool({ name, arguments: { query: "rust", folder: "Dev", limit: 5 } });
      assert.equal(result.isError, true, name);
      assert.equal(result.content[0].text, message, name);
    }
  } finally {
    await client.close();
  }
});

test("e2e: the explaining server offers the same tools as the real one", async () => {
  const cache = mkdtempSync(path.join(os.tmpdir(), "mnemos-cache-"));
  const client = await connect([path.join(ROOT, "dist", "cli.js")], {
    CHROME_BOOKMARKS_PATH: FIXTURE,
    MNEMOS_CACHE_DIR: cache,
    MNEMOS_EMBEDDER: "fake",
    MNEMOS_FETCH_PAGES: "0",
  });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  } finally {
    await client.close();
    rmSync(cache, { recursive: true, force: true, maxRetries: 5 });
  }
});
