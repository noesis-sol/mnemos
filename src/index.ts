#!/usr/bin/env node
/**
 * mnemos — MCP server exposing the user's browser bookmarks (read-only).
 *
 * The user's bookmarks are a curated signal of what they consider important,
 * trustworthy, and worth endorsing. This server lets an AI assistant consult
 * that signal: which topics the user cares about, which sources they approve
 * of, and what they have been saving recently.
 *
 * Startup flags (each wins over its environment variable):
 *   --browser <id>           as MNEMOS_BOOKMARKS_BROWSER
 *   --profile <name>         as MNEMOS_PROFILE
 *
 * Environment variables:
 *   MNEMOS_BOOKMARKS_BROWSER chrome (default), chrome-beta, chrome-dev,
 *                            chrome-canary, chromium, edge, brave, vivaldi,
 *                            opera, firefox, librewolf, waterfox, zen, floorp,
 *                            tor-browser or safari
 *   MNEMOS_PROFILE           Profile display name or directory (default: the
 *                            profile the browser last used, else Default; for
 *                            Firefox and its forks, the one it opens); CHROME_PROFILE is an
 *                            older alias
 *   MNEMOS_BOOKMARKS_PATH    Absolute path to any supported browser's bookmarks
 *                            file (overrides the above); CHROME_BOOKMARKS_PATH
 *                            is an older alias
 *   MNEMOS_FETCH_PAGES       0 turns off fetching bookmarked pages in the
 *                            background (fetcher.ts)
 *   MNEMOS_BROWSER           Path to a Chromium-based browser's executable to
 *                            render JavaScript-only pages with (headless.ts);
 *                            0 turns rendering off. Default: an installed
 *                            Chrome, Edge, Chromium or Brave
 *   MNEMOS_INSTALL_RUNTIME   0 keeps mnemos from installing the embedding
 *                            runtime (@huggingface/transformers) into its cache
 *                            directory on first use (runtime.ts); semantic_search
 *                            then matches keywords only
 *
 * All logic lives in lib.ts; this file is MCP wiring only.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as lib from "./lib.js";
import { parseStartupArgs, setStartupOptions } from "./browsers.js";
import { ICONS } from "./icon.js";
import { createEmbedder } from "./embedder.js";
import { Indexer } from "./indexer.js";
import { Fetcher } from "./fetcher.js";
import { MAX_LIMIT, DEFAULT_LIMIT, semanticSearch } from "./semantic.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Serialize a tool result; convert thrown errors (loadRoots() failures, empty input) into isError results. */
function safely(fn: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(fn()) }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

/** safely() for a tool whose work is asynchronous. */
async function safelyAsync(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return safely(() => result);
  } catch (e) {
    return safely(() => {
      throw e;
    });
  }
}

const embedder = createEmbedder();
/** Embeds bookmark titles in the background; semantic_search reads what it stores. */
const indexer = new Indexer({ embedder });
/**
 * Fetches bookmarked pages and stores their text, in the one process holding
 * the fetcher lease; the indexer then chunks and embeds what it stored.
 */
const fetcher = new Fetcher({ onPage: () => indexer.pagesChanged() });

const server = new McpServer(
  { name: "mnemos", version: VERSION, icons: ICONS },
  {
    instructions:
      "Read-only access to the user's browser bookmarks. Bookmarks are things " +
      "the user deliberately saved: treat them as a map of what the user " +
      "considers important and which sources/opinions they endorse. Folder " +
      "names indicate topics of interest. Use search_bookmarks to check " +
      "whether the user has saved material containing exact words (a name, a " +
      "product, a term), and semantic_search to find saved material by " +
      "meaning: related wording, synonyms, or titles in other languages than " +
      "the query's. Use list_folders to see their interest areas, top_domains " +
      "to see which sources they trust, and recent_bookmarks to see what they " +
      "are currently focused on.",
  },
);

server.registerTool(
  "search_bookmarks",
  {
    title: "Search bookmarks",
    description:
      "Search the user's bookmarks by title, URL, folder path and description. " +
      "Use this to check whether the user has saved material about a topic — " +
      "a hit means the user found that page important or agreeable. Every " +
      "word in `query` must appear in the title, URL, folder path or " +
      "description (case-" +
      "insensitive), matching at the start of a word: 'kubernet' finds " +
      "'Kubernetes', but 'ai' does not match 'Gmail'. Note: because the " +
      "folder path is searched too, a topic word matches everything filed " +
      "under a folder of that name. Optionally restrict to folders whose name " +
      "matches `folder` (whole-word match). Bookmarks carry a `description` " +
      "only where the browser stores one (Vivaldi, Firefox and its forks, Safari's Reading " +
      "List). Returns JSON with " +
      "`total_matches`; if it exceeds `limit`, the list is truncated — do not " +
      "assume the returned items are all there is.",
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
  "semantic_search",
  {
    title: "Semantic search over bookmarks",
    description:
      "Find the user's bookmarks by meaning, not exact words: a query finds " +
      "bookmarks about the same thing in other wording or another language " +
      "(the model is multilingual). Use this when search_bookmarks finds " +
      "nothing or too little, or when the topic can be phrased many ways. " +
      "Bookmarks containing every query word (search_bookmarks' rule) always " +
      "rank first. Each result has `score` (similarity, higher is closer), " +
      "`matched_on` (\"title\", \"page\" with a `snippet` of the page, or " +
      "\"keyword\") and the usual bookmark fields. Only results above a " +
      "relevance cutoff are returned; `count_above_threshold` counts them all, " +
      "and if it exceeds `limit` the list is truncated. `status` reports " +
      "indexing progress (\"titles x/N · pages y/N\", y counting pages with " +
      "embedded text), the embedding model's state, whether page fetching is " +
      "disabled, and `page_states`, how many pages are in each fetch state " +
      "(pending, ok, needs_browser, needs_login, no_content, failed, skipped); while the model is not " +
      "ready, results are keyword matches only and `status.note` says why. " +
      "`status.fetching` says what the background page fetcher is doing, and " +
      "`status.browser`, when present, how many pages need a browser to be read " +
      "and how to provide one. A " +
      "`notice`, when present, is a one-time message for the user: pass it on.",
    inputSchema: {
      query: z.string().describe("What to look for, in any words or language"),
      folder: z
        .string()
        .optional()
        .describe("Restrict to folders whose name matches (word-boundary)"),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`Max results (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT})`),
    },
  },
  async ({ query, folder, limit }) =>
    safelyAsync(() => semanticSearch({ embedder, indexer, fetcher }, query, folder, limit)),
);

server.registerTool(
  "list_folders",
  {
    title: "List bookmark folders",
    description:
      "List the user's whole bookmark folder tree with bookmark counts. " +
      "Folder names are the user's own taxonomy of what matters to them — use " +
      "this to get an overview of their interest areas before searching. " +
      "Nested paths are shown as segments joined with ' › '. Every folder is " +
      "listed, including ones holding only subfolders: `bookmarks` counts " +
      "only bookmarks sitting directly in that folder, while " +
      "`subtree_bookmarks` includes its subfolders and is what " +
      "list_folder_contents on that name would return.",
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
      "see what the user is currently interested in or researching. Bookmarks " +
      "whose stored date is missing or impossible (in the future) sort last " +
      "and report `added: null`; a `note` says when some or all of the list " +
      "is in file order because the browser stores no date (Safari keeps " +
      "dates only for Reading List items). Returns JSON with `total_matches`; if it " +
      "exceeds `limit`, the list is truncated.",
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
      "returns to — treat them as the user's approved sources. Returns JSON " +
      "with `total_matches` (distinct domains); if it exceeds `limit`, the " +
      "list is truncated — the returned domains are the user's top sources, " +
      "not the complete set of sources they trust.",
    inputSchema: {
      limit: z.number().int().optional().describe("Max domains (default 25, cap 100)"),
    },
  },
  async ({ limit }) => safely(() => lib.topDomains(limit)),
);


/** Aborts the fetches in flight and gives the fetcher lease up, so another mnemos can take over. */
function shutdown(): void {
  fetcher.stop();
}

async function main(): Promise<void> {
  try {
    setStartupOptions(parseStartupArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`mnemos: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  // The client closing stdin is how an MCP server is told to exit.
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      shutdown();
      process.exit(0);
    });
  }
  await server.connect(new StdioServerTransport());
  // After connect, and on a later tick: the handshake never waits for indexing.
  indexer.start();
  // Pages after titles: the title pass is what makes semantic_search useful first.
  void indexer.idle().then(() => fetcher.start());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
