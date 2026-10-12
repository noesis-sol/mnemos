// What a client learns from `initialize` alone: the server's identity, its
// icons, its instructions and its capabilities. Spawns the built server over
// stdio like server.test.js, and checks the handshake before any tool call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");
const { version: VERSION } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

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

test("initialize: serverInfo names mnemos at the package.json version", () => {
  const info = client.getServerVersion();
  assert.equal(info.name, "mnemos");
  assert.equal(info.version, VERSION);
});

test("initialize: serverInfo carries six SVG or PNG data-URI icons", () => {
  const { icons } = client.getServerVersion();
  assert.equal(icons.length, 6);
  for (const icon of icons) {
    assert.ok(
      ["image/svg+xml", "image/png"].includes(icon.mimeType),
      `unexpected mimeType ${icon.mimeType}`,
    );
    assert.ok(
      icon.src.startsWith(`data:${icon.mimeType};base64,`),
      `src is a data URI of its own mimeType`,
    );
  }
});

test("initialize: instructions are sent and point at search_bookmarks", () => {
  const instructions = client.getInstructions();
  assert.equal(typeof instructions, "string");
  assert.ok(instructions.length > 0);
  assert.match(instructions, /search_bookmarks/);
});

test("initialize: capabilities advertise tools", () => {
  const capabilities = client.getServerCapabilities();
  assert.ok(capabilities.tools, "tools capability is present");
});
