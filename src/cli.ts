#!/usr/bin/env node
/**
 * The mnemos-mcp bin: checks the Node version before loading the server.
 *
 * index.ts imports node:sqlite (through the index store), which Node only has
 * from 22.13, and an ES module's imports load before any of its code runs. On
 * an older Node the server would die before it could say why, and the MCP
 * client would show only "failed to connect". So this file imports nothing at
 * the top: on a supported Node it loads the server; on an older one it serves
 * the reason over MCP (unsupported-node.ts), where the assistant can relay it.
 *
 * Keep this file and unsupported-node.ts loadable on Node 18.
 */

import { supportsNode } from "./node-version.js";

if (supportsNode(process.versions.node)) {
  await import("./index.js");
} else {
  const { serveUnsupportedNode } = await import("./unsupported-node.js");
  await serveUnsupportedNode(process.versions.node);
}
