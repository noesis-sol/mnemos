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
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { domainToUnicode } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

function chromeBase(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
        "Google",
        "Chrome",
        "User Data",
      );
    default: // linux and other unixes
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        "google-chrome",
      );
  }
}

const CHROME_BASE = chromeBase();

interface BookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  children?: BookmarkNode[];
}

interface Entry {
  folder: string;
  node: BookmarkNode;
}

function bookmarksPath(): string {
  const override = process.env.CHROME_BOOKMARKS_PATH;
  if (override) return override;
  const profile = process.env.CHROME_PROFILE || "Default"; // empty string → Default
  return path.join(CHROME_BASE, profile, "Bookmarks");
}

function loadRoots(): Record<string, BookmarkNode> {
  const file = bookmarksPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    let available: string[] = [];
    try {
      available = fs
        .readdirSync(CHROME_BASE)
        .filter((d) => fs.existsSync(path.join(CHROME_BASE, d, "Bookmarks")))
        .sort();
    } catch {
      // CHROME_BASE itself missing — fall through with empty list
    }
    throw new Error(
      `No bookmarks file at ${file}. ` +
        `Chrome profiles that have bookmarks: ${available.join(", ") || "none"}. ` +
        "Set CHROME_PROFILE (profile directory name) or CHROME_BOOKMARKS_PATH.",
    );
  }
  try {
    return JSON.parse(raw).roots ?? {};
  } catch (e) {
    throw new Error(
      `Bookmarks file at ${file} is not valid JSON (${e}). ` +
        "Chrome may be mid-write; retry in a moment.",
    );
  }
}

// Chrome timestamps are microseconds since 1601-01-01 UTC. Imported or
// corrupted bookmarks can carry out-of-range values — never let one bad
// timestamp fail a whole tool call. Dates are rendered in the machine's
// local timezone so "added yesterday evening" doesn't shift a day.
function chromeTimeToIso(value: string | undefined): string | null {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  const date = new Date(micros / 1000 - 11_644_473_600_000);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function* walk(node: BookmarkNode, folder: string): Generator<Entry> {
  for (const child of node.children ?? []) {
    if (child.type === "url") {
      yield { folder, node: child };
    } else if (child.type === "folder") {
      // Join with " › " rather than "/": folder names can themselves contain
      // slashes (e.g. "Vision / OCR"), which would corrupt segment matching.
      yield* walk(child, `${folder} › ${child.name ?? ""}`);
    }
  }
}

const ROOT_LABELS: Record<string, string> = {
  bookmark_bar: "Bookmarks Bar",
  other: "Other Bookmarks",
  synced: "Mobile Bookmarks",
};

function* allBookmarks(): Generator<Entry> {
  for (const [key, root] of Object.entries(loadRoots())) {
    if (root && typeof root === "object") {
      yield* walk(root, ROOT_LABELS[key] ?? key);
    }
  }
}

/**
 * True if `needle` matches a folder name in the path at a word boundary.
 * Matching per path segment (not the joined path) prevents false positives
 * like "ai" matching "Painting". JS `\b` is ASCII-only, so Unicode-aware
 * lookarounds are required for non-Latin folder names (e.g. Greek).
 */
function folderMatches(fpath: string, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return true;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
  return fpath.split(" › ").some((segment) => pattern.test(segment.toLowerCase()));
}

function fmt(entry: Entry) {
  return {
    title: entry.node.name ?? "",
    url: entry.node.url ?? "",
    folder: entry.folder,
    added: chromeTimeToIso(entry.node.date_added),
  };
}

function cap(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(limit ?? fallback, 200));
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Convert loadRoots() failures into friendly tool errors instead of crashes. */
function safely(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

const server = new McpServer(
  { name: "mnemos", version: VERSION },
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
  async ({ query, folder, limit }) =>
    safely(() => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        return jsonResult({
          error:
            "Empty query. Provide one or more search words, or use " +
            "list_folders / recent_bookmarks to browse instead.",
        });
      }
      const matches = [];
      for (const entry of allBookmarks()) {
        if (folder && !folderMatches(entry.folder, folder)) continue;
        const haystack =
          `${entry.node.name ?? ""} ${entry.node.url ?? ""} ${entry.folder}`.toLowerCase();
        if (words.every((w) => haystack.includes(w))) {
          matches.push(fmt(entry));
        }
      }
      if (matches.length === 0) {
        return jsonResult({
          total_matches: 0,
          matches: [],
          note: `No bookmarks match "${query}".`,
        });
      }
      return jsonResult({
        total_matches: matches.length,
        matches: matches.slice(0, cap(limit, 100)),
      });
    }),
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
  async () =>
    safely(() => {
      const counts = new Map<string, number>();
      for (const entry of allBookmarks()) {
        counts.set(entry.folder, (counts.get(entry.folder) ?? 0) + 1);
      }
      const folders = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([folder, n]) => ({ folder, bookmarks: n }));
      const total = folders.reduce((sum, f) => sum + f.bookmarks, 0);
      return jsonResult({ folders, total_bookmarks: total });
    }),
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
  async ({ folder, limit }) =>
    safely(() => {
      if (!folder.trim()) {
        return jsonResult({
          error: "Empty folder name. Call list_folders to see available folders.",
        });
      }
      const matches = [];
      for (const entry of allBookmarks()) {
        if (folderMatches(entry.folder, folder)) {
          matches.push(fmt(entry));
        }
      }
      if (matches.length === 0) {
        return jsonResult({
          total_matches: 0,
          bookmarks: [],
          note: `No folder matches "${folder}".`,
        });
      }
      return jsonResult({
        total_matches: matches.length,
        bookmarks: matches.slice(0, cap(limit, 100)),
      });
    }),
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
  async ({ limit }) =>
    safely(() => {
      const items: { added: number; entry: Entry }[] = [];
      for (const entry of allBookmarks()) {
        const added = Number(entry.node.date_added);
        items.push({ added: Number.isFinite(added) ? added : 0, entry });
      }
      items.sort((a, b) => b.added - a.added);
      return jsonResult({
        bookmarks: items.slice(0, cap(limit, 100)).map((i) => fmt(i.entry)),
      });
    }),
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
  async ({ limit }) =>
    safely(() => {
      const counts = new Map<string, number>();
      for (const entry of allBookmarks()) {
        let host = "";
        try {
          const url = new URL(entry.node.url ?? "");
          // Only web pages count as "sources" — skip chrome://, file://, etc.
          if (url.protocol !== "http:" && url.protocol !== "https:") continue;
          // Render internationalized domains readably, not as xn-- punycode.
          host = domainToUnicode(url.hostname.replace(/^www\./, ""));
        } catch {
          continue; // bookmarklets and malformed URLs
        }
        if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, Math.max(1, Math.min(limit ?? 25, 100)))
        .map(([domain, n]) => ({ domain, bookmarks: n }));
      return jsonResult({ domains: top });
    }),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
