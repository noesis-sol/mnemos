/**
 * The background page fetcher: fetches each bookmarked page under the fetch
 * policy (fetch.ts), extracts its readable text with Readability on a linkedom
 * document (extract.ts, in a worker thread), and stores the text and the
 * outcome in the index store's `pages` table, where the chunker and
 * semantic_search read them.
 *
 * One process at a time: several mnemos servers (one per MCP client) can share
 * the index, and only the one holding the store's "fetcher" lease fetches. It
 * renews the lease on a heartbeat and gives it up on exit; the others serve
 * queries from the shared index and take the lease over if it lapses.
 *
 * Fresh over time: an ok page is fetched again REFRESH_MS (30 days) after it
 * was fetched, and the indexer embeds it again only if its text changed. A
 * failed page is retried after 1 h, 6 h, 1 d, 7 d, then every 30 d
 * (BACKOFF_STEPS_MS), its fail_count kept. needs_login and skipped pages
 * wait 30 days too, or go again at once when the fetch policy changes; a
 * no_content page (no text even in the browser) is not fetched again. Pages of deleted bookmarks are dropped
 * by the indexer's sync (IndexStore.syncBookmarks).
 *
 * Polite and in the background: pages never fetched before refreshes and
 * retries, newest bookmarks first, at most CONCURRENCY fetches at once, one at
 * a time per domain, and DOMAIN_GAP_MS between the end of one request to a
 * domain and the start of the next. It yields to the event
 * loop between steps, and an error is recorded on its page (failed, retried
 * with backoff) rather than thrown; nothing here throws into a tool call.
 *
 * Polite over every source: the fetchers of the selected bookmarks files (one
 * each) share a FetchPool, so these limits hold over all of them together, and
 * a freed slot goes to the fetcher with the fewest fetches in flight. A page
 * another source's fetcher fetched within SHARED_FRESH_MS (a URL saved in
 * several browsers) is taken from that fetcher's index, not fetched again.
 *
 * A page that comes back with no readable text (a JavaScript shell) is marked
 * needs_browser and loaded again in a headless browser (headless.ts), at most
 * BROWSER_PAGES at a time, under the same per-domain rules. The browser is
 * launched on the first such page and closed once none is left. With no
 * browser or no playwright-core, those pages stay needs_browser and
 * browserNote() says so.
 *
 * A bookmarked PDF is fetched as bytes and its text read with pdf.js (pdf.ts),
 * then stored like a page's: the same content_hash, chunks and embeddings. A
 * PDF with no text (a scan; there is no OCR) is no_content for good and never
 * goes to the browser; an encrypted one is skipped ("encrypted"), and a broken
 * one failed, with backoff. Without unpdf, PDFs are not fetched (skipped as
 * not-html).
 *
 * MNEMOS_FETCH_PAGES=0 turns it off entirely.
 */

import crypto from "node:crypto";
import { checkUrl, fetchConfig, isSkippedFolder, safeFetch, type FetchConfig, type FetchOptions, type FetchOutcome } from "./fetch.js";
import { Extractor, type Extraction } from "./extract.js";
import { BROWSER_PAGES, HeadlessBrowser, type PageRenderer, type Unavailable } from "./headless.js";
import { IndexStore, type PageRow } from "./index-store.js";
import * as lib from "./lib.js";
import { extractPdfText, pdfSupport, type PdfModule, type PdfTextResult } from "./pdf.js";

/** Fetches in flight at once, over all domains. */
export const CONCURRENCY = 4;
/** At least this long between the end of one request to a domain and the start of the next. */
export const DOMAIN_GAP_MS = 1_000;
export const LEASE_NAME = "fetcher";
/** How long the lease lasts unless renewed; a process that dies frees it after this. */
export const LEASE_TTL_MS = 30_000;
/** How often the holder renews the lease, and the others try to take it. */
export const HEARTBEAT_MS = 10_000;
/** With nothing to fetch, how often to look for new bookmarks and retries that came due. */
export const IDLE_POLL_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** How long a failed page waits after its 1st, 2nd, 3rd, 4th failure; from the 5th on, the last. */
export const BACKOFF_STEPS_MS = [HOUR_MS, 6 * HOUR_MS, DAY_MS, 7 * DAY_MS, 30 * DAY_MS];
export const BACKOFF_BASE_MS = BACKOFF_STEPS_MS[0];
export const BACKOFF_MAX_MS = BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1];
/**
 * An ok page is fetched again this long after it was fetched, and so is one
 * that came back needs_login or skipped by the fetch itself (a policy change
 * makes those due at once).
 */
export const REFRESH_MS = 30 * DAY_MS;
/** A page another source's fetcher fetched this recently is taken from its index, not fetched again. */
export const SHARED_FRESH_MS = DAY_MS;

/** Shown once per index, on the first semantic_search answer after fetching starts. */
export const FIRST_FETCH_NOTE =
  "mnemos is now fetching your bookmarked pages in the background to index their content; " +
  "set MNEMOS_FETCH_PAGES=0 to stop.";
/** meta keys: when fetching first started for this index, and the note not yet shown. */
const STARTED_KEY = "fetch_started_at";
const NOTE_KEY = "fetch_note_pending";
/** meta key: the fetch policy the last refill applied, as JSON. */
const POLICY_KEY = "fetch_policy";

/** Skip reasons that come from MNEMOS_SKIP_DOMAINS / MNEMOS_SKIP_FOLDERS, re-checked at each refill. */
const CONFIG_SKIPS = new Set(["skip-domain", "skip-folder"]);

/** Page fetching is on unless MNEMOS_FETCH_PAGES=0. */
export function fetchingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MNEMOS_FETCH_PAGES?.trim() === "0";
}

// --- scheduling --------------------------------------------------------------

/** How long to wait before retrying a page that has now failed `failCount` times. */
export function backoffMs(failCount: number): number {
  return BACKOFF_STEPS_MS[Math.min(BACKOFF_STEPS_MS.length, Math.max(1, failCount)) - 1];
}

/** The politeness key of a URL: its host, lower-case, without www. */
export function domainKey(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw;
  }
}

/** Milliseconds since the epoch of a bookmark's date_added, or 0 if it has none or a bad one. */
function addedAt(node: lib.BookmarkNode): number {
  if (lib.chromeTimeToIso(node.date_added) === null) return 0;
  return Number(node.date_added) / 1000 - 11_644_473_600_000;
}

/** A sha256 of the page's text, so a refetch can tell whether it changed. */
export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** A page's extracted text or state, or (for a PDF that cannot be read) a reason to skip it. */
export type PageExtraction = Extraction | { status: "skipped"; reason: string };

/**
 * What a PDF's text extraction comes to for its page; undefined when it was
 * aborted (shutdown), and the page stays as it was.
 */
export function pdfExtraction(result: PdfTextResult): PageExtraction | undefined {
  if (result.status === "ok") {
    return result.text.trim() ? { status: "ok", text: result.text } : { status: "no_content", reason: "no text in the PDF" };
  }
  if (result.status === "unavailable") return { status: "skipped", reason: "pdf-unavailable" };
  switch (result.reason) {
    case "aborted":
      return undefined;
    case "encrypted":
      return { status: "skipped", reason: "encrypted" };
    default:
      return { status: "failed", reason: result.detail ? `pdf ${result.reason}: ${result.detail}` : `pdf ${result.reason}` };
  }
}

/** The page row a fetch outcome comes to, given the page's previous fail count. */
export function pageResult(
  url: string,
  outcome: FetchOutcome,
  extraction: PageExtraction | undefined,
  failCount: number,
  now: number,
): PageRow {
  const base = { url, final_url: outcome.url, fetched_at: now };
  const failed = (reason: string, waitMs = 0): PageRow => {
    const fails = failCount + 1;
    return {
      ...base,
      status: "failed",
      fail_count: fails,
      next_attempt_at: now + Math.max(backoffMs(fails), waitMs),
      content_hash: null,
      reason,
      text: null,
    };
  };
  switch (outcome.status) {
    case "ok":
      if (!extraction) return failed("no extraction");
      if (extraction.status === "failed") return failed(extraction.reason);
      if (extraction.status === "skipped") {
        return { ...base, status: "skipped", fail_count: 0, next_attempt_at: now + REFRESH_MS, reason: extraction.reason, text: null };
      }
      if (extraction.status === "ok") {
        return {
          ...base,
          status: "ok",
          fail_count: 0,
          next_attempt_at: now + REFRESH_MS,
          content_hash: contentHash(extraction.text),
          reason: null,
          text: extraction.text,
        };
      }
      return {
        ...base,
        status: extraction.status,
        fail_count: 0,
        // no_content is for good (and, from a plain fetch, goes to the browser instead).
        next_attempt_at: extraction.status === "needs_login" ? now + REFRESH_MS : null,
        reason: extraction.reason,
        text: null,
      };
    case "skipped":
      return { ...base, status: "skipped", fail_count: 0, next_attempt_at: now + REFRESH_MS, reason: outcome.reason, text: null };
    case "refused":
      return failed(`refused: HTTP ${outcome.httpStatus}`, outcome.retryAfterMs);
    case "failed": {
      const detail = outcome.httpStatus !== undefined ? `HTTP ${outcome.httpStatus}` : outcome.detail;
      return failed(detail ? `${outcome.reason}: ${detail}` : outcome.reason);
    }
  }
}

/**
 * This source's page row from the row another source's index has for the
 * same URL, when that one was fetched within SHARED_FRESH_MS and after this
 * source's last fetch of it; undefined when the page must be fetched here.
 * `browser`: this source's page waits for the browser, so another's
 * needs_browser is no answer.
 */
export function adoptedRow(
  theirs: Required<PageRow>,
  previous: Required<PageRow>,
  browser: boolean,
  now: number,
): PageRow | undefined {
  const at = theirs.fetched_at;
  if (at === null || now - at > SHARED_FRESH_MS) return undefined;
  if (previous.fetched_at !== null && at <= previous.fetched_at) return undefined;
  const row: PageRow = {
    url: previous.url,
    status: theirs.status,
    final_url: theirs.final_url,
    fetched_at: at,
    fail_count: 0,
    next_attempt_at: theirs.next_attempt_at,
    content_hash: theirs.content_hash,
    reason: theirs.reason,
    text: theirs.text,
  };
  switch (theirs.status) {
    case "ok":
    case "no_content":
    case "needs_login":
      return row;
    case "skipped":
      // A skip list's skip is this source's own to apply (its folders differ); the fetch's own is shared.
      if (theirs.next_attempt_at === null || (theirs.reason !== null && CONFIG_SKIPS.has(theirs.reason))) return undefined;
      return row;
    case "needs_browser":
      return browser ? undefined : { ...row, fail_count: previous.fail_count, next_attempt_at: null };
    case "failed": {
      const fails = previous.fail_count + 1;
      return { ...row, fail_count: fails, next_attempt_at: Math.max(theirs.next_attempt_at ?? 0, at + backoffMs(fails)) };
    }
    default:
      return undefined;
  }
}

// --- the pool ----------------------------------------------------------------

export interface FetchPoolOptions {
  /** Fetches in flight at once, over every fetcher; defaults to CONCURRENCY. */
  concurrency?: number;
  domainGapMs?: number;
  /** Pages in a browser at once, over every fetcher; defaults to BROWSER_PAGES. */
  browserPages?: number;
}

/**
 * What the fetchers of several bookmarks files share, so their politeness
 * holds over all of them: the fetches in flight, the domains being fetched
 * and when each was last, and the pages in a browser. Also the way to the
 * others' indexes, for a page one of them fetched lately.
 */
export class FetchPool {
  readonly concurrency: number;
  readonly domainGapMs: number;
  readonly browserPages: number;
  private active = 0;
  private browserActive = 0;
  private readonly busyDomains = new Set<string>();
  /** When the last request to each domain ended. */
  private readonly lastDone = new Map<string, number>();
  /** The started fetchers. */
  private readonly members = new Set<Fetcher>();

  constructor(options: FetchPoolOptions = {}) {
    this.concurrency = options.concurrency ?? CONCURRENCY;
    this.domainGapMs = options.domainGapMs ?? DOMAIN_GAP_MS;
    this.browserPages = options.browserPages ?? BROWSER_PAGES;
  }

  join(fetcher: Fetcher): void {
    this.members.add(fetcher);
  }

  leave(fetcher: Fetcher): void {
    this.members.delete(fetcher);
  }

  /** Whether another fetch may start. */
  hasRoom(): boolean {
    return this.active < this.concurrency;
  }

  /**
   * How long until a request to `domain` may start: 0 now, Infinity while
   * one is in flight (or, for a browser page, while the browser is full).
   */
  waitMs(domain: string, browser: boolean, now: number): number {
    if (this.busyDomains.has(domain)) return Infinity;
    if (browser && this.browserActive >= this.browserPages) return Infinity;
    return Math.max(0, (this.lastDone.get(domain) ?? -Infinity) + this.domainGapMs - now);
  }

  take(domain: string, browser: boolean): void {
    this.active++;
    this.busyDomains.add(domain);
    if (browser) this.browserActive++;
  }

  release(domain: string, browser: boolean, now: number): void {
    this.active--;
    this.busyDomains.delete(domain);
    this.lastDone.set(domain, now);
    if (browser) this.browserActive--;
  }

  /**
   * After `from`'s fetch ended: lets the fetchers with pages waiting start
   * theirs, the one with the fewest in flight first (`from` last among
   * equals), so one source's long queue does not hold every slot.
   */
  dispatch(from: Fetcher): void {
    const order = [...this.members]
      .filter((member) => member === from || member.hasQueue())
      .sort((a, b) => a.inFlight() - b.inFlight() || Number(a === from) - Number(b === from));
    if (!order.includes(from)) order.push(from);
    for (const member of order) member.poke();
  }

  /** The freshest row another fetcher's index has for `url`, if any. */
  sharedPage(url: string, from: Fetcher): Required<PageRow> | undefined {
    let best: Required<PageRow> | undefined;
    for (const member of this.members) {
      if (member === from) continue;
      const row = member.storedPage(url);
      if (row?.fetched_at != null && (best?.fetched_at == null || row.fetched_at > best.fetched_at)) best = row;
    }
    return best;
  }
}

// --- the fetcher -------------------------------------------------------------

export type FetchFn = (url: string, options: FetchOptions) => Promise<FetchOutcome>;

export interface FetcherStatus {
  /**
   * disabled: MNEMOS_FETCH_PAGES=0. standby: another process holds the lease.
   * fetching: pages are being fetched. idle: nothing is due. failed: the
   * index could not be used (`error`); retried at the next heartbeat.
   */
  state: "disabled" | "not_started" | "standby" | "fetching" | "idle" | "failed" | "stopped";
  /** Pages fetched by this process since it started. */
  fetched: number;
  error?: string;
}

export interface FetcherOptions {
  /** Defaults to process.env: MNEMOS_FETCH_PAGES and the fetch policy's variables. */
  env?: NodeJS.ProcessEnv;
  /** The Bookmarks file; defaults to lib.bookmarksPath(). */
  bookmarksFile?: () => string;
  /** The bookmarks; defaults to lib.allBookmarks(). */
  entries?: () => Iterable<lib.Entry>;
  /** Where the index lives; defaults to the store's cacheDir(). */
  dir?: string;
  /** Defaults to safeFetch. */
  fetch?: FetchFn;
  /** Passed to every fetch (a test's CA, timeouts). */
  fetchOptions?: Omit<FetchOptions, "signal" | "folder" | "config">;
  /**
   * Shared with the fetchers of the other selected bookmarks files; when
   * given, `concurrency`, `browserPages` and `domainGapMs` are the pool's.
   */
  pool?: FetchPool;
  concurrency?: number;
  /** Renders pages that need a browser; defaults to a HeadlessBrowser on `env`. */
  renderer?: PageRenderer;
  /** Pages in the browser at once; defaults to BROWSER_PAGES. */
  browserPages?: number;
  domainGapMs?: number;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  idlePollMs?: number;
  /** Clock in ms since the epoch, for tests. */
  now?: () => number;
  /** Called after a page's outcome is stored (the indexer's pagesChanged), never throwing into the fetcher. */
  onPage?: (url: string) => void;
  /** Loads the PDF parser; defaults to pdf.ts's import("unpdf"). For tests. */
  pdfLoad?: () => Promise<PdfModule>;
}

interface QueueItem {
  url: string;
  domain: string;
  folders: string[];
  added: number;
  /** Never fetched: it goes ahead of refreshes and retries. */
  pending?: boolean;
  /** Load it in the browser: its plain fetch had no readable text. */
  browser?: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class Fetcher {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bookmarksFile: () => string;
  private readonly entries: () => Iterable<lib.Entry>;
  private readonly dir: string | undefined;
  private readonly fetch: FetchFn;
  private readonly fetchOptions: FetcherOptions["fetchOptions"];
  private readonly pool: FetchPool;
  private readonly renderer: PageRenderer;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly idlePollMs: number;
  private readonly now: () => number;
  private readonly onPage: (url: string) => void;
  private readonly pdfLoad: (() => Promise<PdfModule>) | undefined;
  /** Whether PDFs can be read here: asked of pdf.ts once, on the first fetch. */
  private pdfReadable: Promise<boolean> | undefined;

  private current: FetcherStatus = { state: "not_started", fetched: 0 };
  private store: IndexStore | undefined;
  private storeFile: string | undefined;
  private holding = false;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private queue: QueueItem[] = [];
  private readonly active = new Map<string, AbortController>();
  /** This fetcher's pages in its browser now. */
  private browserActive = 0;
  /** Why the browser cannot render pages in this process, once a launch found out. */
  private browserUnavailable: Unavailable | undefined;
  /** Page text extraction, off the event loop. */
  private readonly extractor = new Extractor();
  /** Settles when no fetch is in flight; for tests and shutdown. */
  private settled: Promise<void> = Promise.resolve();

  constructor(options: FetcherOptions = {}) {
    this.env = options.env ?? process.env;
    this.bookmarksFile = options.bookmarksFile ?? (() => lib.bookmarksPath());
    this.entries = options.entries ?? (() => lib.allBookmarks());
    this.dir = options.dir;
    this.fetch = options.fetch ?? safeFetch;
    this.fetchOptions = options.fetchOptions;
    this.pool =
      options.pool ??
      new FetchPool({ concurrency: options.concurrency, browserPages: options.browserPages, domainGapMs: options.domainGapMs });
    this.renderer = options.renderer ?? new HeadlessBrowser({ env: this.env });
    this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
    this.now = options.now ?? Date.now;
    this.onPage = options.onPage ?? (() => {});
    this.pdfLoad = options.pdfLoad;
    if (fetchingDisabled(this.env)) this.current = { state: "disabled", fetched: 0 };
  }

  status(): FetcherStatus {
    return { ...this.current };
  }

  /** Whether this process holds the fetcher lease. */
  isHolder(): boolean {
    return this.holding;
  }

  /**
   * "N pages need a browser; set MNEMOS_BROWSER" (or why else there is none),
   * once a launch found no usable browser and pages are waiting for one;
   * else undefined.
   */
  browserNote(): string | undefined {
    if (!this.browserUnavailable) return undefined;
    let waiting = 0;
    try {
      waiting = this.store?.pageCounts().needs_browser ?? 0;
    } catch {
      return undefined;
    }
    if (waiting === 0) return undefined;
    const pages = waiting === 1 ? "1 page needs" : `${waiting} pages need`;
    return `${pages} a browser; ${this.browserUnavailable.hint}`;
  }

  /**
   * FIRST_FETCH_NOTE the first time this is called after fetching first
   * started for this index, in whichever process asks first; else undefined.
   */
  takeNote(): string | undefined {
    try {
      return this.store?.takeMeta(NOTE_KEY) !== undefined ? FIRST_FETCH_NOTE : undefined;
    } catch {
      return undefined;
    }
  }

  /** Starts the heartbeat: takes the lease if it is free and starts fetching. Does nothing when disabled. */
  start(): void {
    if (this.current.state === "disabled" || this.stopped || this.heartbeat) return;
    this.pool.join(this);
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    this.heartbeat.unref();
    this.beat();
  }

  /** Resolves once no fetch is in flight. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await this.settled;
  }

  // --- for the pool --------------------------------------------------------------

  /** This fetcher's fetches in flight. */
  inFlight(): number {
    return this.active.size;
  }

  /** Whether pages are queued, waiting for a slot. */
  hasQueue(): boolean {
    return this.holding && !this.stopped && this.queue.length > 0;
  }

  /** Starts what it can now that a slot may be free; never throws. */
  poke(): void {
    try {
      this.pump();
    } catch (err) {
      this.fail(err);
    }
  }

  /** This index's row for `url`, for another source's fetcher; undefined when there is none or the index cannot be read. */
  storedPage(url: string): Required<PageRow> | undefined {
    try {
      return this.store?.getPage(url);
    } catch {
      return undefined;
    }
  }

  /**
   * Shutdown: aborts the fetches in flight (their pages stay as they were),
   * gives the lease up and closes the store. Synchronous, so it can run from
   * a signal handler right before exit.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pool.leave(this);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.heartbeat = this.wakeTimer = undefined;
    for (const controller of this.active.values()) controller.abort();
    this.extractor.close();
    void this.renderer.close();
    this.queue = [];
    if (this.holding) {
      try {
        this.store?.releaseLease(LEASE_NAME);
      } catch {
        // the lease expires by itself
      }
    }
    this.holding = false;
    this.closeStore();
    if (this.current.state !== "disabled") this.current = { ...this.current, state: "stopped" };
  }

  // --- the lease ---------------------------------------------------------------

  /** Renews the lease if held, else tries to take it and start. */
  private beat(): void {
    if (this.stopped) return;
    try {
      const store = this.openStore();
      if (this.holding) {
        if (!store.renewLease(LEASE_NAME, this.leaseTtlMs)) {
          this.lose();
          return;
        }
        // Bookmarks added while a long queue (say a day's 30-day refreshes) drains go ahead of it,
        // not behind: refill when the index has bookmarks with no page yet.
        if (this.queue.length > 0 && store.addPendingPages() > 0) {
          this.refill();
          this.pump();
        }
        return;
      }
      if (!store.acquireLease(LEASE_NAME, this.leaseTtlMs)) {
        this.current = { state: "standby", fetched: this.current.fetched };
        return;
      }
      this.holding = true;
      if (store.addMeta(STARTED_KEY, String(this.now()))) store.setMeta(NOTE_KEY, "1");
      this.current = { state: "fetching", fetched: this.current.fetched };
      this.refill();
      this.pump();
    } catch (err) {
      this.fail(err);
    }
  }

  /** The lease is gone (expired or taken over): stop fetching until it is taken again. */
  private lose(): void {
    this.holding = false;
    for (const controller of this.active.values()) controller.abort();
    this.queue = [];
    void this.renderer.close();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.current = { state: "standby", fetched: this.current.fetched };
  }

  private fail(err: unknown): void {
    const error = message(err);
    // stderr, never stdout (the MCP channel); once per distinct error.
    if (this.current.error !== error) console.error(`mnemos: fetching pages failed: ${error}`);
    if (this.holding) {
      try {
        this.store?.releaseLease(LEASE_NAME);
      } catch {
        // the lease expires by itself
      }
    }
    this.lose();
    // A store that went bad is reopened at the next heartbeat.
    this.closeStore();
    this.current = { state: "failed", fetched: this.current.fetched, error };
  }

  private openStore(): IndexStore {
    const file = this.bookmarksFile();
    if (this.store && this.storeFile === file) return this.store;
    this.closeStore();
    // No model: the fetcher must not drop the indexer's vectors over a model it does not know.
    this.store = IndexStore.open({ bookmarksFile: file, dir: this.dir, now: this.now });
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

  // --- the queue ---------------------------------------------------------------

  /**
   * Re-reads the bookmarks, adds pages for new URLs, applies the skip lists
   * to every page, and queues the pages that are due: pending ones (never
   * fetched) first, then failed ones whose backoff is over and pages last
   * fetched REFRESH_MS ago, each newest bookmark first.
   */
  private refill(): void {
    const store = this.store;
    if (!store || !this.holding) return;
    const config = fetchConfig(this.env);
    const info = new Map<string, { folders: string[]; added: number }>();
    for (const { folder, node } of this.entries()) {
      const url = node.url ?? "";
      const known = info.get(url);
      if (known) {
        known.folders.push(folder);
        known.added = Math.max(known.added, addedAt(node));
      } else {
        info.set(url, { folders: [folder], added: addedAt(node) });
      }
    }
    store.addPendingPages();
    this.applyPolicy(store, info, config);
    const now = this.now();
    const due: QueueItem[] = [];
    for (const { url, pending } of store.duePages(now)) {
      const bookmark = info.get(url);
      if (!bookmark || this.active.has(url)) continue;
      due.push({ url, domain: domainKey(url), ...bookmark, pending });
    }
    // Pages left needing a browser by an earlier run (or one that had none); duePages leaves
    // them to this loop, which waits out a next attempt set on one, like duePages.
    if (!this.browserUnavailable) {
      for (const page of store.pageStates()) {
        const bookmark = info.get(page.url);
        if (page.status !== "needs_browser" || !bookmark || this.active.has(page.url)) continue;
        if (page.next_attempt_at !== null && page.next_attempt_at > now) continue;
        due.push({ url: page.url, domain: domainKey(page.url), ...bookmark, browser: true });
      }
    }
    due.sort((a, b) => Number(b.pending ?? false) - Number(a.pending ?? false) || b.added - a.added);
    this.queue = due;
  }

  /**
   * Applies the fetch policy to every page. Marks pages the skip lists now
   * cover as skipped, dropping their text and chunks; these wait, never due,
   * until a skip list no longer covers them, and then go back to pending.
   * When the policy (MNEMOS_SKIP_*, MNEMOS_FETCH_ALLOW_HOSTS) is not the one
   * the last refill applied, needs_login pages and those the fetch itself
   * skipped (a redirect to a skipped domain, a private address) are due at once.
   */
  private applyPolicy(
    store: IndexStore,
    info: Map<string, { folders: string[] }>,
    config: FetchConfig,
  ): void {
    const policy = JSON.stringify(config);
    const policyChanged = store.getMeta(POLICY_KEY) !== policy;
    const now = this.now();
    for (const page of store.pageStates()) {
      const bookmark = info.get(page.url);
      if (!bookmark) continue;
      const check = checkUrl(page.url, config);
      let skip: string | undefined;
      if (bookmark.folders.some((folder) => isSkippedFolder(folder, config))) skip = "skip-folder";
      else if (!check.ok && CONFIG_SKIPS.has(check.reason)) skip = check.reason;
      // A skip list's skip has no next attempt; the fetch's own (with the same reason, after a redirect) has one.
      const listSkipped = page.status === "skipped" && page.next_attempt_at === null;
      if (skip && !(listSkipped && page.reason === skip)) {
        store.upsertPage({ url: page.url, status: "skipped", reason: skip, text: null });
        store.replaceChunks(page.url, []);
      } else if (!skip && listSkipped && page.reason !== null && CONFIG_SKIPS.has(page.reason)) {
        store.upsertPage({ url: page.url, status: "pending", text: null });
      } else if (!skip && policyChanged && (page.status === "skipped" || page.status === "needs_login")) {
        store.setNextAttempt(page.url, now);
      }
    }
    if (policyChanged) store.setMeta(POLICY_KEY, policy);
  }

  /**
   * Starts fetches while the pool has room, each on a domain that is free and
   * has rested; a page another source's fetcher fetched lately is taken from
   * its index instead.
   */
  private pump(): void {
    if (!this.holding || this.stopped) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    let waitMs = Infinity;
    while (this.pool.hasRoom()) {
      const now = this.now();
      let picked = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const { domain, browser } = this.queue[i];
        const wait = this.pool.waitMs(domain, browser ?? false, now);
        if (wait > 0) {
          if (wait < Infinity) waitMs = Math.min(waitMs, wait);
          continue;
        }
        picked = i;
        break;
      }
      if (picked < 0) break;
      const item = this.queue.splice(picked, 1)[0];
      if (this.adopt(item)) {
        if (!this.holding || this.stopped) return;
        continue;
      }
      this.launch(item);
    }
    if (this.active.size === 0 && this.queue.length === 0) {
      this.current = { state: "idle", fetched: this.current.fetched };
      this.wake(this.idlePollMs, () => {
        try {
          this.refill();
          this.pump();
        } catch (err) {
          this.fail(err);
        }
      });
    } else if (waitMs < Infinity && this.pool.hasRoom()) {
      this.wake(waitMs, () => this.pump());
    }
  }

  private wake(delayMs: number, fn: () => void): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      fn();
    }, delayMs);
    this.wakeTimer.unref();
  }

  private launch(item: QueueItem): void {
    const controller = new AbortController();
    this.active.set(item.url, controller);
    this.pool.take(item.domain, item.browser ?? false);
    if (item.browser) this.browserActive++;
    this.current = { state: "fetching", fetched: this.current.fetched };
    const run = (item.browser ? this.renderOne(item, controller.signal) : this.fetchOne(item, controller.signal)).finally(() => {
      this.active.delete(item.url);
      this.pool.release(item.domain, item.browser ?? false, this.now());
      if (item.browser) this.browserActive--;
      if (!this.stopped && this.holding) {
        // The browser stays open only while pages wait for it.
        if (item.browser && this.browserActive === 0 && !this.queue.some((queued) => queued.browser)) {
          void this.renderer.close();
        }
        // When the queue ran dry, look for more right away: new bookmarks, or retries now due.
        try {
          if (this.queue.length === 0 && this.active.size === 0) this.refill();
        } catch (err) {
          this.fail(err);
        }
      }
      // The freed slot: to this fetcher or another source's, whichever has the fewest in flight.
      this.pool.dispatch(this);
    });
    this.settled = Promise.allSettled([this.settled, run]).then(() => undefined);
  }

  /**
   * Records a page another source's fetcher fetched lately (adoptedRow) as
   * this one's, with no request; whether the page is done with (taken, gone,
   * or the index failed). Never throws.
   */
  private adopt(item: QueueItem): boolean {
    const theirs = this.pool.sharedPage(item.url, this);
    if (!theirs || !this.store) return false;
    try {
      const previous = this.store.getPage(item.url);
      if (!previous) return true; // the bookmark went away meanwhile
      const row = adoptedRow(theirs, previous, item.browser ?? false, this.now());
      if (!row) return false;
      this.store.upsertPage(row);
      if (row.status === "needs_browser" && !this.browserUnavailable) this.queue.unshift({ ...item, browser: true });
      this.current = { ...this.current, fetched: this.current.fetched + 1 };
    } catch (err) {
      this.fail(err);
      return true;
    }
    try {
      this.onPage(item.url);
    } catch (err) {
      console.error(`mnemos: after storing ${item.url}: ${message(err)}`);
    }
    return true;
  }

  /** Fetches one page and records what happened; never throws. */
  private async fetchOne(item: QueueItem, signal: AbortSignal): Promise<void> {
    let outcome: FetchOutcome;
    try {
      this.pdfReadable ??= pdfSupport(this.pdfLoad).then((support) => support.available);
      outcome = await this.fetch(item.url, {
        ...this.fetchOptions,
        config: fetchConfig(this.env),
        folder: item.folders[0],
        // Without a PDF parser, PDFs are skipped as not-html, unread.
        acceptPdf: await this.pdfReadable,
        signal,
      });
    } catch (err) {
      outcome = { status: "failed", reason: "connection", url: item.url, detail: message(err) };
    }
    await this.record(item, outcome, signal);
  }

  /**
   * Loads a page that needs a browser in the browser, launching it if need
   * be, and records what happened; never throws. With no usable browser the
   * page stays needs_browser, and so do the others queued for the browser.
   */
  private async renderOne(item: QueueItem, signal: AbortSignal): Promise<void> {
    let outcome: FetchOutcome;
    try {
      const launched = await this.renderer.launch();
      if (!launched.ok) {
        if (!this.browserUnavailable) console.error(`mnemos: no browser to render pages with: ${launched.reason}`);
        this.browserUnavailable = launched;
        this.queue = this.queue.filter((queued) => !queued.browser);
        return;
      }
      if (signal.aborted || this.stopped || !this.holding) return;
      // Where the plain fetch ended up, after its https upgrade and redirects.
      const from = this.store?.getPage(item.url)?.final_url ?? item.url;
      outcome = await this.renderer.render(from, { config: fetchConfig(this.env), signal });
    } catch (err) {
      outcome = { status: "failed", reason: "connection", url: item.url, detail: message(err) };
    }
    await this.record(item, outcome, signal);
  }

  /** Extracts a fetched or rendered page's text and stores the page's new state. */
  private async record(item: QueueItem, outcome: FetchOutcome, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.stopped || !this.holding) return; // the page stays as it was
    await yieldToEventLoop();
    let extraction: PageExtraction | undefined;
    const pdf = outcome.status === "ok" && outcome.kind === "pdf";
    if (outcome.status === "ok" && outcome.kind === "html") {
      try {
        extraction = await this.extractor.extract(outcome.html, outcome.url);
      } catch (err) {
        extraction = { status: "failed", reason: `extraction failed: ${message(err)}` };
      }
      await yieldToEventLoop();
    } else if (outcome.status === "ok") {
      // On the event loop, a page at a time with a yield between pages; never throws.
      extraction = pdfExtraction(await extractPdfText(outcome.pdf, { signal, load: this.pdfLoad }));
      if (!extraction) return; // aborted: the page stays as it was
    }
    if (signal.aborted || this.stopped || !this.holding || !this.store) return;
    try {
      const previous = this.store.getPage(item.url);
      if (!previous) return; // the bookmark went away meanwhile
      let row = pageResult(item.url, outcome, extraction, previous.fail_count, this.now());
      // A PDF with no text is a scan, not a JavaScript shell: the browser would see no more.
      if (row.status === "no_content" && !item.browser && !pdf) {
        // A JavaScript shell, perhaps: the browser has the last word. The fail
        // count carries over, so a page the browser keeps failing backs off.
        row = { ...row, status: "needs_browser", fail_count: previous.fail_count };
        if (!this.browserUnavailable) this.queue.unshift({ ...item, browser: true });
      }
      this.store.upsertPage(row);
      this.current = { ...this.current, fetched: this.current.fetched + 1 };
    } catch (err) {
      this.fail(err);
      return;
    }
    try {
      this.onPage(item.url);
    } catch (err) {
      console.error(`mnemos: after storing ${item.url}: ${message(err)}`);
    }
  }
}
