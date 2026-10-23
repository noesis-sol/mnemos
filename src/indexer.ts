/**
 * The background title indexer: keeps one vector per bookmark in the index
 * store, computed from the bookmark's title, description, folder path and the
 * words of its URL.
 *
 * It starts after the MCP handshake has been set up and never holds it or a
 * tool call up: the file is read and the store synced in one short step, then
 * the titles are embedded in batches with a yield to the event loop between
 * them. Only rows whose text (text_hash) or model changed are embedded again.
 *
 * After the titles, each run cuts the text of fetched pages into chunks
 * (chunk.ts) and embeds them the same way, in smaller batches since a chunk
 * is longer than a title. A page is cut again only when its text
 * (content_hash) changed, so a re-fetch of the same text embeds nothing.
 *
 * It re-runs when the Bookmarks file changes. There is no fs.watch: callers
 * (semantic_search) call checkForChanges(), which compares the file's mtime
 * and size with those of the last run and schedules a debounced re-index, and
 * the indexer makes the same comparison itself every CHANGE_POLL_MS, so the
 * store's bookmarks, and with them the pages the fetcher fetches, follow the
 * file even when no semantic_search comes. The page fetcher calls
 * pagesChanged() when it stores a page, which schedules a run of the page
 * pass alone.
 *
 * Every error is caught and kept in status(); nothing here throws into a tool.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { domainToUnicode } from "node:url";
import { chunkEmbeddingText, chunkText } from "./chunk.js";
import type { Embedder } from "./embedder.js";
import { IndexStore, type BookmarkRow, type PageStatus } from "./index-store.js";
import * as lib from "./lib.js";

/** Titles per embed() call: progress is updated and vectors stored after each. */
export const TITLE_BATCH = 32;
/** Page chunks per embed() call: a chunk is up to ~350 tokens, a title ~20, so fewer at once. */
export const CHUNK_BATCH = 8;
/** How long checkForChanges() waits before re-indexing, so a burst of calls runs it once. */
export const REINDEX_DEBOUNCE_MS = 2_000;
/** How often the indexer looks at the Bookmarks file's mtime and size for a change of its own accord. */
export const CHANGE_POLL_MS = 60_000;

/** At most this many URL words go into the text, so a long URL cannot crowd the title out. */
const MAX_URL_WORDS = 32;
/**
 * At most this many characters of the description go into the text, so a long
 * one (Safari's Reading List preview text) cannot push the folder path and URL
 * words past what the embedder reads.
 */
export const MAX_DESCRIPTION_CHARS = 300;
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

/**
 * The description as it goes into the text: on one line, and if longer than
 * MAX_DESCRIPTION_CHARS, cut at the last space before that (or at the limit
 * when the last space is in the first half), never inside a surrogate pair.
 */
export function clipDescription(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= MAX_DESCRIPTION_CHARS) return text;
  const cut = chars.slice(0, MAX_DESCRIPTION_CHARS + 1).join("");
  const space = cut.lastIndexOf(" ");
  if (space >= cut.length / 2) return cut.slice(0, space);
  return chars.slice(0, MAX_DESCRIPTION_CHARS).join("");
}

/**
 * What a bookmark's vector is computed from: its title, description (see
 * lib.describe, clipped by clipDescription), folder path and URL words, a line
 * each.
 */
export function embeddingText(bookmark: {
  title: string;
  description?: string | null;
  folder_path: string;
  url: string;
}): string {
  const description = clipDescription(bookmark.description ?? "");
  return [bookmark.title.trim(), description, bookmark.folder_path, urlWords(bookmark.url)]
    .filter(Boolean)
    .join("\n");
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
    // null, not undefined: a description removed in the browser is cleared in the store too.
    const row = { guid, url, title: node.name ?? "", folder_path: folder, description: lib.describe(node) ?? null };
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

export interface IndexScores {
  titles: Map<string, number>;
  pages: Map<string, { score: number; text: string }>;
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
  /** How often to look for a changed Bookmarks file; defaults to CHANGE_POLL_MS. */
  pollMs?: number;
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
  private readonly pollMs: number;
  private readonly now: () => number;

  private store: IndexStore | undefined;
  private storeFile: string | undefined;
  private current: IndexerStatus = { state: "not_started", titles_done: 0, titles_total: 0 };
  /** The file as the last complete run read it; undefined until one completes. */
  private indexedSignature: string | undefined;
  /** The file as the last run read it, complete or not; undefined until one starts. */
  private readSignature: string | undefined;
  private poll: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** What to run once the run in progress ends: nothing, the page pass, or everything. */
  private again: "none" | "pages" | "full" = "none";
  private timer: NodeJS.Timeout | undefined;
  /** Whether the scheduled run includes the titles, or is the page pass alone. */
  private timerFull = false;

  constructor(options: IndexerOptions) {
    this.embedder = options.embedder;
    this.bookmarksFile = options.bookmarksFile ?? (() => lib.bookmarksPath());
    this.entries = options.entries ?? (() => lib.allBookmarks());
    this.dir = options.dir;
    this.debounceMs = options.debounceMs ?? REINDEX_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? CHANGE_POLL_MS;
    this.now = options.now ?? Date.now;
  }

  status(): IndexerStatus {
    return { ...this.current };
  }

  /** The progress line's numbers. */
  progress(): { titles_done: number; titles_total: number } {
    return { titles_done: this.current.titles_done, titles_total: this.current.titles_total };
  }

  /**
   * The query's similarity to every embedded title (by guid) and to each
   * page's best chunk (by URL), from the open index; undefined while no run
   * has opened it, or after one failed.
   */
  scores(query: Float32Array): IndexScores | undefined {
    if (!this.store) return undefined;
    return { titles: this.store.bookmarkScores(query), pages: this.store.bestChunks(query) };
  }

  /** Pages with embedded chunks; 0 while the index is not open or cannot be read. */
  embeddedPages(): number {
    try {
      return this.store?.embeddedPageCount() ?? 0;
    } catch {
      return 0;
    }
  }

  /** How many pages are in each fetch state ({ ok: 12, failed: 1, … }); empty while the index is not open or cannot be read. */
  pageCounts(): Partial<Record<PageStatus, number>> {
    try {
      return this.store?.pageCounts() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Starts the first run on a later turn of the event loop, so the caller (the
   * handshake) goes first, then looks for a changed file every pollMs.
   */
  start(): void {
    this.schedule(0, true);
    if (this.poll) return;
    this.poll = setInterval(() => this.pollForChanges(), this.pollMs);
    this.poll.unref();
  }

  /**
   * A page's text was stored: schedules a debounced run of the page pass, so
   * a burst of fetched pages is chunked and embedded together.
   */
  pagesChanged(): void {
    this.schedule(this.debounceMs, false);
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
      if (!unchanged) this.schedule(this.debounceMs, true);
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

  /** Stops scheduled runs and the poll and closes the store; a run in progress stops at its next batch. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.closeStore();
  }

  /**
   * Schedules a re-index if the Bookmarks file changed since the last run read
   * it. Unlike checkForChanges(), it does not retry a run that failed on the
   * same file: the next semantic_search does, under the embedder's backoff.
   */
  private pollForChanges(): void {
    try {
      if (fileSignature(this.bookmarksFile()) !== this.readSignature) this.schedule(this.debounceMs, true);
    } catch (err) {
      this.fail(err);
    }
  }

  /** A run after `delayMs`, unless one is already scheduled; `full` includes the titles. */
  private schedule(delayMs: number, full: boolean): void {
    this.timerFull ||= full;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      const scheduledFull = this.timerFull;
      this.timer = undefined;
      this.timerFull = false;
      this.run(scheduledFull);
    }, delayMs);
    this.timer.unref();
  }

  /** Runs now, or once more after the run in progress. The page pass alone needs an open store. */
  private run(full: boolean): void {
    if (this.running) {
      if (full) this.again = "full";
      else if (this.again === "none") this.again = "pages";
      return;
    }
    const work = full || !this.store ? this.index() : this.indexPagesOnly(this.store);
    this.running = work
      .catch((err) => this.fail(err))
      .finally(() => {
        this.running = undefined;
        const again = this.again;
        this.again = "none";
        if (again !== "none") this.run(again === "full");
      });
  }

  private fail(err: unknown): void {
    const error = message(err);
    // stderr, never stdout (the MCP channel); once per distinct error, not per retry.
    if (this.current.error !== error) console.error(`mnemos: indexing bookmarks failed: ${error}`);
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
    this.readSignature = signature;
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
    await this.indexPagesOnly(store);
  }

  private async indexPagesOnly(store: IndexStore): Promise<void> {
    try {
      await this.indexPages(store);
    } catch (err) {
      this.closeStore();
      throw err;
    }
  }

  /**
   * Cuts the pages whose text changed into chunks, then embeds every chunk
   * that has no vector, the bookmark's title before each, CHUNK_BATCH at a
   * time with a yield between.
   */
  private async indexPages(store: IndexStore): Promise<void> {
    for (const page of store.pagesToChunk()) {
      if (this.store !== store) return;
      const text = page.content_hash === null ? null : store.getPage(page.url)?.text;
      store.replaceChunks(page.url, text ? chunkText(text) : [], page.content_hash);
      await yieldToEventLoop();
    }
    for (;;) {
      if (this.store !== store) return;
      const batch = store.chunksWithoutVector(CHUNK_BATCH);
      if (batch.length === 0) return;
      const titles = new Map<string, string>();
      for (const c of batch) if (!titles.has(c.url)) titles.set(c.url, store.pageTitle(c.url));
      const vectors = await this.embedder.embed(
        batch.map((c) => chunkEmbeddingText(titles.get(c.url)!, c.text)),
        "passage",
      );
      if (this.store !== store) return;
      let stored = 0;
      batch.forEach((c, j) => (stored += Number(store.setChunkVector(c.url, c.ordinal, c.text, vectors[j]))));
      // Every chunk of the batch was replaced meanwhile (another process cut the page again): try once more later.
      if (stored === 0) return void this.pagesChanged();
      await yieldToEventLoop();
    }
  }
}
