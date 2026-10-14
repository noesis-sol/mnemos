/**
 * The MCP server mnemos runs on a Node older than MIN_NODE: it completes the
 * handshake and answers every tool with why mnemos cannot run here and what to
 * do, so the user hears it from the assistant instead of seeing only "failed
 * to connect". It offers the real server's tools so an assistant that reaches
 * for the bookmarks gets the explanation.
 *
 * Loaded by cli.ts only on an old Node: keep it loadable on Node 18 (the MCP
 * SDK's own minimum), so no node:sqlite and nothing from the rest of mnemos.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MIN_NODE } from "./node-version.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

/** The real server's tools (index.ts); a test checks the two lists match. */
export const TOOL_NAMES = [
  "search_bookmarks",
  "semantic_search",
  "list_folders",
  "list_folder_contents",
  "recent_bookmarks",
  "top_domains",
];

/** What the user needs to hear, for `nodeVersion` (as in process.versions.node). */
export function unsupportedNodeMessage(nodeVersion: string): string {
  return (
    `mnemos ${VERSION} needs Node.js ${MIN_NODE} or later, but this machine runs Node.js ${nodeVersion}, ` +
    `so it cannot read the user's bookmarks. Tell the user to either upgrade Node.js ` +
    `(https://nodejs.org), or keep using mnemos 0.3, which runs on Node.js 18 and later, ` +
    `by changing "mnemos-mcp" to "mnemos-mcp@0.3" in their MCP server configuration ` +
    `(for example: npx -y mnemos-mcp@0.3). Then restart the MCP client.`
  );
}

export async function serveUnsupportedNode(nodeVersion: string): Promise<void> {
  const message = unsupportedNodeMessage(nodeVersion);
  console.error(`mnemos: ${message}`);
  const server = new McpServer({ name: "mnemos", version: VERSION }, { instructions: message });
  for (const name of TOOL_NAMES) {
    server.registerTool(name, { description: `Unavailable: ${message}` }, async () => ({
      content: [{ type: "text" as const, text: message }],
      isError: true,
    }));
  }
  await server.connect(new StdioServerTransport());
}
