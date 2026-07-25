#!/usr/bin/env node
/**
 * mnemos — MCP server exposing the user's Chrome bookmarks (read-only).
 *
 * The user's bookmarks are a curated signal of what they consider important,
 * trustworthy, and worth endorsing. This server lets an AI assistant consult
 * that signal: which topics the user cares about, which sources they approve
 * of, and what they have been saving recently.
 *
 * Environment variables:
 *   CHROME_PROFILE        Chrome profile directory name (default: "Default")
 *   CHROME_BOOKMARKS_PATH Absolute path to a Bookmarks file (overrides the above)
 *
 * All logic lives in lib.ts; this file is MCP wiring only.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as lib from "./lib.js";
import { ICONS } from "./icon.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Serialize a tool result; convert loadRoots() failures into friendly errors. */
function safely(fn: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(fn()) }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

const server = new McpServer(
  { name: "mnemos", version: VERSION, icons: ICONS },
  {
    instructions:
      "Read-only access to the user's Chrome bookmarks. Bookmarks are things " +
      "the user deliberately saved: treat them as a map of what the user " +
      "considers important and which sources/opinions they endorse. Folder " +
      "names indicate topics of interest. Use search_bookmarks to check " +
      "whether the user has saved material on a topic, list_folders to see " +
      "their interest areas, top_domains to see which sources they trust, " +
      "and recent_bookmarks to see what they are currently focused on.",
  },
);

server.registerTool(
  "search_bookmarks",
  {
    title: "Search bookmarks",
    description:
      "Search the user's bookmarks by title, URL, and folder path. Use this " +
      "to check whether the user has saved material about a topic — a hit " +
      "means the user found that page important or agreeable. All words in " +
      "`query` must appear in the title, URL, or folder path (case-" +
      "insensitive). Note: because the folder path is searched too, a topic " +
      "word matches everything filed under a folder of that name. Optionally " +
      "restrict to folders whose name matches `folder` (word-boundary match). " +
      "Returns JSON with `total_matches`; if it exceeds `limit`, the list is " +
      "truncated — do not assume the returned items are all there is.",
    inputSchema: {
      query: z.string().describe("Search words; all must match"),
      folder: z
        .string()
        .optional()
        .describe("Restrict to folders whose name matches (word-boundary)"),
      limit: z.number().int().optional().describe("Max results (default 100, cap 200)"),
    },
  },
  async ({ query, folder, limit }) => safely(() => lib.searchBookmarks(query, folder, limit)),
);

server.registerTool(
  "list_folders",
  {
    title: "List bookmark folders",
    description:
      "List the user's bookmark folder tree with bookmark counts. Folder " +
      "names are the user's own taxonomy of what matters to them — use this " +
      "to get an overview of their interest areas before searching. Nested " +
      "paths are shown as segments joined with ' › '.",
    inputSchema: {},
  },
  async () => safely(() => lib.listFolders()),
);

server.registerTool(
  "list_folder_contents",
  {
    title: "List folder contents",
    description:
      "List bookmarks in folders whose name matches `folder` (case-" +
      "insensitive word-boundary match on folder names, subfolders " +
      "included). Use after list_folders to read everything the user saved " +
      "on a topic. Returns JSON with `total_matches`; if it exceeds `limit`, " +
      "the list is truncated — do not assume the returned items are all " +
      "there is.",
    inputSchema: {
      folder: z.string().describe("Folder name to match (word-boundary)"),
      limit: z.number().int().optional().describe("Max results (default 100, cap 200)"),
    },
  },
  async ({ folder, limit }) => safely(() => lib.listFolderContents(folder, limit)),
);

server.registerTool(
  "recent_bookmarks",
  {
    title: "Recent bookmarks",
    description:
      "Return the most recently added bookmarks, newest first. Use this to " +
      "see what the user is currently interested in or researching.",
    inputSchema: {
      limit: z.number().int().optional().describe("Max results (default 100, cap 200)"),
    },
  },
  async ({ limit }) => safely(() => lib.recentBookmarks(limit)),
);

server.registerTool(
  "top_domains",
  {
    title: "Top bookmarked domains",
    description:
      "Return the domains the user bookmarks most often, with counts. " +
      "Frequently bookmarked domains are sources the user trusts and " +
      "returns to — treat them as the user's approved sources.",
    inputSchema: {
      limit: z.number().int().optional().describe("Max domains (default 25, cap 100)"),
    },
  },
  async ({ limit }) => safely(() => lib.topDomains(limit)),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
