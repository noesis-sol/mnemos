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
 * Polite and in the background: newest bookmarks first, at most CONCURRENCY
 * fetches at once, one at a time per domain, and DOMAIN_GAP_MS between the end
 * of one request to a domain and the start of the next. It yields to the event
 * loop between steps, and an error is recorded on its page (failed, retried
 * with backoff) rather than thrown; nothing here throws into a tool call.
 *
 * MNEMOS_FETCH_PAGES=0 turns it off entirely.
 */

import crypto from "node:crypto";
import { checkUrl, fetchConfig, isSkippedFolder, safeFetch, type FetchConfig, type FetchOptions, type FetchOutcome } from "./fetch.js";
import { Extractor, type Extraction } from "./extract.js";
import { IndexStore, type PageRow } from "./index-store.js";
import * as lib from "./lib.js";

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
/** The first retry of a failed page waits this long; each further failure doubles it, up to BACKOFF_MAX_MS. */
export const BACKOFF_BASE_MS = 60 * 60_000;
export const BACKOFF_MAX_MS = 7 * 24 * 60 * 60_000;

/** Shown once per index, on the first semantic_search answer after fetching starts. */
export const FIRST_FETCH_NOTE =
  "mnemos is now fetching your bookmarked pages in the background to index their content; " +
  "set MNEMOS_FETCH_PAGES=0 to stop.";
/** meta keys: when fetching first started for this index, and the note not yet shown. */
const STARTED_KEY = "fetch_started_at";
const NOTE_KEY = "fetch_note_pending";

/** Skip reasons that come from MNEMOS_SKIP_DOMAINS / MNEMOS_SKIP_FOLDERS, re-checked at each refill. */
const CONFIG_SKIPS = new Set(["skip-domain", "skip-folder"]);

/** Page fetching is on unless MNEMOS_FETCH_PAGES=0. */
export function fetchingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MNEMOS_FETCH_PAGES?.trim() === "0";
}

// --- scheduling --------------------------------------------------------------

/** How long to wait before retrying a page that has now failed `failCount` times. */
export function backoffMs(failCount: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1));
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

/** The page row a fetch outcome comes to, given the page's previous fail count. */
export function pageResult(
  url: string,
  outcome: FetchOutcome,
  extraction: Extraction | undefined,
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
      if (extraction.status === "ok") {
        return {
          ...base,
          status: "ok",
          fail_count: 0,
          next_attempt_at: null,
          content_hash: contentHash(extraction.text),
          reason: null,
          text: extraction.text,
        };
      }
      return { ...base, status: extraction.status, fail_count: 0, next_attempt_at: null, reason: extraction.reason, text: null };
    case "skipped":
      return { ...base, status: "skipped", fail_count: 0, next_attempt_at: null, reason: outcome.reason, text: null };
    case "refused":
      return failed(`refused: HTTP ${outcome.httpStatus}`, outcome.retryAfterMs);
    case "failed": {
      const detail = outcome.httpStatus !== undefined ? `HTTP ${outcome.httpStatus}` : outcome.detail;
      return failed(detail ? `${outcome.reason}: ${detail}` : outcome.reason);
    }
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
  concurrency?: number;
  domainGapMs?: number;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  idlePollMs?: number;
  /** Clock in ms since the epoch, for tests. */
  now?: () => number;
}

interface QueueItem {
  url: string;
  domain: string;
  folders: string[];
  added: number;
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
  private readonly concurrency: number;
  private readonly domainGapMs: number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly idlePollMs: number;
  private readonly now: () => number;

  private current: FetcherStatus = { state: "not_started", fetched: 0 };
  private store: IndexStore | undefined;
  private storeFile: string | undefined;
  private holding = false;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private queue: QueueItem[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly busyDomains = new Set<string>();
  /** When the last request to each domain ended. */
  private readonly lastDone = new Map<string, number>();
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
    this.concurrency = options.concurrency ?? CONCURRENCY;
    this.domainGapMs = options.domainGapMs ?? DOMAIN_GAP_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
    this.now = options.now ?? Date.now;
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
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    this.heartbeat.unref();
    this.beat();
  }

  /** Resolves once no fetch is in flight. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await this.settled;
  }

  /**
   * Shutdown: aborts the fetches in flight (their pages stay as they were),
   * gives the lease up and closes the store. Synchronous, so it can run from
   * a signal handler right before exit.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.heartbeat = this.wakeTimer = undefined;
    for (const controller of this.active.values()) controller.abort();
    this.extractor.close();
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
        if (!store.renewLease(LEASE_NAME, this.leaseTtlMs)) this.lose();
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
   * to every page, and queues the pages that are due, newest bookmark first.
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
    this.applySkipLists(store, info, config);
    const due: QueueItem[] = [];
    for (const url of store.duePages(this.now())) {
      const bookmark = info.get(url);
      if (!bookmark || this.active.has(url)) continue;
      due.push({ url, domain: domainKey(url), ...bookmark });
    }
    due.sort((a, b) => b.added - a.added);
    this.queue = due;
  }

  /**
   * Marks pages the skip lists now cover as skipped, dropping their text and
   * chunks, and puts back to pending those a skip list no longer covers.
   */
  private applySkipLists(
    store: IndexStore,
    info: Map<string, { folders: string[] }>,
    config: FetchConfig,
  ): void {
    for (const page of store.pageStates()) {
      const bookmark = info.get(page.url);
      if (!bookmark) continue;
      const check = checkUrl(page.url, config);
      let skip: string | undefined;
      if (bookmark.folders.some((folder) => isSkippedFolder(folder, config))) skip = "skip-folder";
      else if (!check.ok && CONFIG_SKIPS.has(check.reason)) skip = check.reason;
      if (skip && !(page.status === "skipped" && page.reason === skip)) {
        store.upsertPage({ url: page.url, status: "skipped", reason: skip, text: null });
        store.replaceChunks(page.url, []);
      } else if (!skip && page.status === "skipped" && page.reason !== null && CONFIG_SKIPS.has(page.reason)) {
        store.upsertPage({ url: page.url, status: "pending", text: null });
      }
    }
  }

  /** Starts fetches up to the concurrency limit, each on a domain that is free and has rested. */
  private pump(): void {
    if (!this.holding || this.stopped) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    let waitMs = Infinity;
    while (this.active.size < this.concurrency) {
      const now = this.now();
      let picked = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const { domain } = this.queue[i];
        if (this.busyDomains.has(domain)) continue;
        const ready = (this.lastDone.get(domain) ?? -Infinity) + this.domainGapMs;
        if (ready > now) {
          waitMs = Math.min(waitMs, ready - now);
          continue;
        }
        picked = i;
        break;
      }
      if (picked < 0) break;
      this.launch(this.queue.splice(picked, 1)[0]);
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
    } else if (waitMs < Infinity && this.active.size < this.concurrency) {
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
    this.busyDomains.add(item.domain);
    this.current = { state: "fetching", fetched: this.current.fetched };
    const run = this.fetchOne(item, controller.signal).finally(() => {
      this.active.delete(item.url);
      this.busyDomains.delete(item.domain);
      this.lastDone.set(item.domain, this.now());
      if (this.stopped || !this.holding) return;
      // When the queue ran dry, look for more right away: new bookmarks, or retries now due.
      try {
        if (this.queue.length === 0 && this.active.size === 0) this.refill();
        this.pump();
      } catch (err) {
        this.fail(err);
      }
    });
    this.settled = Promise.allSettled([this.settled, run]).then(() => undefined);
  }

  /** Fetches one page and records what happened; never throws. */
  private async fetchOne(item: QueueItem, signal: AbortSignal): Promise<void> {
    let outcome: FetchOutcome;
    try {
      outcome = await this.fetch(item.url, {
        ...this.fetchOptions,
        config: fetchConfig(this.env),
        folder: item.folders[0],
        // PDFs are skipped as not-html until the PDF text is indexed.
        acceptPdf: false,
        signal,
      });
    } catch (err) {
      outcome = { status: "failed", reason: "connection", url: item.url, detail: message(err) };
    }
    if (signal.aborted || this.stopped || !this.holding) return; // the page stays as it was
    await yieldToEventLoop();
    let extraction: Extraction | undefined;
    if (outcome.status === "ok" && outcome.kind === "html") {
      try {
        extraction = await this.extractor.extract(outcome.html, outcome.url);
      } catch (err) {
        extraction = { status: "failed", reason: `extraction failed: ${message(err)}` };
      }
      await yieldToEventLoop();
    } else if (outcome.status === "ok") {
      outcome = { status: "skipped", reason: "not-html", url: outcome.url };
    }
    if (this.stopped || !this.holding || !this.store) return;
    try {
      const previous = this.store.getPage(item.url);
      if (!previous) return; // the bookmark went away meanwhile
      this.store.upsertPage(pageResult(item.url, outcome, extraction, previous.fail_count, this.now()));
      this.current = { ...this.current, fetched: this.current.fetched + 1 };
    } catch (err) {
      this.fail(err);
    }
  }
}
