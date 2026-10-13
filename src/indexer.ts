/**
 * The background title indexer: keeps one vector per bookmark in the index
 * store, computed from the bookmark's title, folder path and the words of its
 * URL.
 *
 * It starts after the MCP handshake has been set up and never holds it or a
 * tool call up: the file is read and the store synced in one short step, then
 * the titles are embedded in batches with a yield to the event loop between
 * them. Only rows whose text (text_hash) or model changed are embedded again.
 *
 * It re-runs when the Bookmarks file changes. There is no fs.watch: callers
 * (semantic_search) call checkForChanges(), which compares the file's mtime
 * and size with those of the last run and schedules a debounced re-index.
 *
 * Every error is caught and kept in status(); nothing here throws into a tool.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { domainToUnicode } from "node:url";
import type { Embedder } from "./embedder.js";
import { IndexStore, type BookmarkRow } from "./index-store.js";
import * as lib from "./lib.js";

/** Titles per embed() call: progress is updated and vectors stored after each. */
export const TITLE_BATCH = 32;
/** How long checkForChanges() waits before re-indexing, so a burst of calls runs it once. */
export const REINDEX_DEBOUNCE_MS = 2_000;

/** At most this many URL words go into the text, so a long URL cannot crowd the title out. */
const MAX_URL_WORDS = 32;
/** Longer "words" are ids and hashes, not words. */
const MAX_WORD_LENGTH = 40;
/** Second-level labels under a two-letter country TLD, dropped with it: bbc.co.uk is "bbc". */
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "go", "gov", "ne", "net", "or", "org"]);
/** File extensions of web pages, dropped from the end of a URL path. */
const PAGE_EXTENSION = /\.(?:html?|shtml|php|aspx?|jsp|cgi)$/i;

// --- the text of a bookmark --------------------------------------------------

/** Splits on everything that is not a letter, digit or mark, and between camelCase humps. */
function splitWords(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((word) => word.length > 0 && word.length <= MAX_WORD_LENGTH);
}

/** The host's words: no www, no TLD, internationalised names in Unicode as top_domains shows them. */
function hostWords(hostname: string): string[] {
  // IP addresses carry no words.
  if (hostname.startsWith("[") || /^\d+(\.\d+){3}$/.test(hostname)) return [];
  const bare = hostname.replace(/^www\./, "");
  const labels = (domainToUnicode(bare) || bare).split(".").filter(Boolean);
  if (labels.length > 1) {
    const tld = labels.pop()!;
    if (labels.length > 1 && tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
  }
  return labels.flatMap(splitWords);
}

/**
 * The words of a web URL, lower-cased and each once: the host's (see
 * hostWords), then the path's, split on / - _ . and camelCase. The query
 * string and fragment are dropped, and so is anything that is not http(s):
 * a bookmarklet's code is not words.
 *
 *   https://github.com/livekit/agents -> "github livekit agents"
 */
export function urlWords(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const words = hostWords(url.hostname);
  for (const segment of url.pathname.replace(PAGE_EXTENSION, "").split("/")) {
    let text = segment;
    try {
      text = decodeURIComponent(segment);
    } catch {
      // a stray % : split it as it is
    }
    words.push(...splitWords(text));
  }
  const unique = [...new Set(words.map((word) => word.toLowerCase()))];
  return unique.slice(0, MAX_URL_WORDS).join(" ");
}

/** What a bookmark's vector is computed from: its title, folder path and URL words, a line each. */
export function embeddingText(bookmark: { title: string; folder_path: string; url: string }): string {
  return [bookmark.title.trim(), bookmark.folder_path, urlWords(bookmark.url)].filter(Boolean).join("\n");
}

export function textHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * The store's rows for the bookmarks as they are now. A Chromium bookmark is
 * keyed by its guid; the Firefox and Safari readers give none, so those are
 * keyed by folder, URL and which copy of that URL in that folder it is, which
 * survives a retitle, an insertion elsewhere and a restart.
 */
export function bookmarkRows(entries: Iterable<lib.Entry>): BookmarkRow[] {
  const rows: BookmarkRow[] = [];
  const copies = new Map<string, number>();
  for (const { folder, node } of entries) {
    const url = node.url ?? "";
    let guid = typeof node.guid === "string" && node.guid ? node.guid : "";
    if (!guid) {
      const place = `${folder}\0${url}`;
      const copy = copies.get(place) ?? 0;
      copies.set(place, copy + 1);
      guid = `h:${textHash(`${place}\0${copy}`).slice(0, 32)}`;
    }
    const row = { guid, url, title: node.name ?? "", folder_path: folder };
    rows.push({ ...row, text_hash: textHash(embeddingText(row)) });
  }
  return rows;
}

// --- the indexer -------------------------------------------------------------

export interface IndexerStatus {
  /** not_started until the first run; failed keeps `error` until a run succeeds. */
  state: "not_started" | "indexing" | "ready" | "failed";
  titles_done: number;
  titles_total: number;
  error?: string;
}

export interface IndexerOptions {
  embedder: Embedder;
  /** The Bookmarks file; defaults to lib.bookmarksPath(), read at each run. */
  bookmarksFile?: () => string;
  /** The bookmarks; defaults to lib.allBookmarks(). */
  entries?: () => Iterable<lib.Entry>;
  /** Where the index lives; defaults to the store's cacheDir(). */
  dir?: string;
  debounceMs?: number;
  /** Clock in ms since the epoch, for tests. */
  now?: () => number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** mtime and size of the file and of its write-ahead log (Firefox's places.sqlite-wal), if any. */
function fileSignature(file: string): string {
  return ["", "-wal"]
    .map((suffix) => {
      try {
        const stat = fs.statSync(file + suffix);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

export class Indexer {
  private readonly embedder: Embedder;
  private readonly bookmarksFile: () => string;
  private readonly entries: () => Iterable<lib.Entry>;
  private readonly dir: string | undefined;
  private readonly debounceMs: number;
  private readonly now: () => number;

  private store: IndexStore | undefined;
  private storeFile: string | undefined;
  private current: IndexerStatus = { state: "not_started", titles_done: 0, titles_total: 0 };
  /** The file as the last complete run read it; undefined until one completes. */
  private indexedSignature: string | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: IndexerOptions) {
    this.embedder = options.embedder;
    this.bookmarksFile = options.bookmarksFile ?? (() => lib.bookmarksPath());
    this.entries = options.entries ?? (() => lib.allBookmarks());
    this.dir = options.dir;
    this.debounceMs = options.debounceMs ?? REINDEX_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
  }

  status(): IndexerStatus {
    return { ...this.current };
  }

  /** The progress line's numbers. */
  progress(): { titles_done: number; titles_total: number } {
    return { titles_done: this.current.titles_done, titles_total: this.current.titles_total };
  }

  /** Starts the first run on a later turn of the event loop, so the caller (the handshake) goes first. */
  start(): void {
    this.schedule(0);
  }

  /**
   * Schedules a re-index if the Bookmarks file changed since the last
   * complete run, or if that run did not complete. Cheap: two stat calls.
   */
  checkForChanges(): void {
    try {
      const unchanged =
        this.current.state !== "failed" &&
        this.indexedSignature !== undefined &&
        fileSignature(this.bookmarksFile()) === this.indexedSignature;
      if (!unchanged) this.schedule(this.debounceMs);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Resolves once no run is in progress or scheduled. */
  async idle(): Promise<void> {
    while (this.timer || this.running) {
      await (this.running ?? new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }

  /** Stops scheduled runs and closes the store; a run in progress stops at its next batch. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.closeStore();
  }

  /** A run after `delayMs`, unless one is already scheduled. */
  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, delayMs);
    this.timer.unref();
  }

  /** Runs now, or once more after the run in progress. */
  private run(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.index()
      .catch((err) => this.fail(err))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.run();
        }
      });
  }

  private fail(err: unknown): void {
    const error = message(err);
    // stderr, never stdout (the MCP channel); once per distinct error, not per retry.
    if (this.current.error !== error) console.error(`mnemos: indexing bookmark titles failed: ${error}`);
    this.current = { ...this.current, state: "failed", error };
  }

  private openStore(file: string): IndexStore {
    if (this.store && this.storeFile === file) return this.store;
    this.closeStore();
    this.store = IndexStore.open({
      bookmarksFile: file,
      dir: this.dir,
      modelId: this.embedder.id,
      modelRevision: this.embedder.revision,
      now: this.now,
    });
    this.storeFile = file;
    return this.store;
  }

  private closeStore(): void {
    try {
      this.store?.close();
    } catch {
      // already closed or unusable
    }
    this.store = undefined;
    this.storeFile = undefined;
  }

  private async index(): Promise<void> {
    const file = this.bookmarksFile();
    // Taken before the read, so a change made while this run reads or embeds
    // is seen by the next checkForChanges().
    const signature = fileSignature(file);
    this.current = { ...this.current, state: "indexing" };
    let store: IndexStore;
    try {
      const rows = bookmarkRows(this.entries());
      store = this.openStore(file);
      store.syncBookmarks(rows);
      const pending = store.bookmarksWithoutVector();
      this.current = {
        ...this.current,
        titles_total: rows.length,
        titles_done: rows.length - pending.length,
      };
      for (let i = 0; i < pending.length; i += TITLE_BATCH) {
        if (i > 0) await yieldToEventLoop();
        if (this.store !== store) return; // closed meanwhile
        const batch = pending.slice(i, i + TITLE_BATCH);
        const vectors = await this.embedder.embed(batch.map(embeddingText), "passage");
        if (this.store !== store) return;
        batch.forEach((b, j) => store.setBookmarkVector(b.guid, b.text_hash, vectors[j]));
        this.current = { ...this.current, titles_done: this.current.titles_done + batch.length };
      }
      store.setMeta("titles_indexed_at", String(this.now()));
    } catch (err) {
      // A store that went bad while open is rebuilt by reopening it next run.
      this.closeStore();
      throw err;
    }
    this.indexedSignature = signature;
    this.current = { state: "ready", titles_done: this.current.titles_done, titles_total: this.current.titles_total };
  }
}
