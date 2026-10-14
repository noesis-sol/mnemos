// Fetchers of several bookmarks files sharing a FetchPool (dist/fetcher.js):
// the concurrency limit holds over all of them, a domain is fetched by one at
// a time with the gap between, a freed slot goes to the fetcher with the
// fewest in flight, and a URL saved in both files is fetched once, the other
// index taking the page from the first (adoptedRow).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { FetchPool, Fetcher, REFRESH_MS, SHARED_FRESH_MS, adoptedRow, backoffMs, domainKey } from "../dist/fetcher.js";

const dirs = [];
const fetchers = [];
after(() => {
  for (const fetcher of fetchers) fetcher.stop();
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

/** Entries as lib.allBookmarks gives them, from URLs, the first the newest. */
function entries(urls) {
  return urls.map((url, i) => ({
    folder: "Bookmarks Bar",
    node: { type: "url", name: url, url, date_added: chromeTime(urls.length - i) },
  }));
}

function article(word) {
  const paragraph = (n) =>
    `<p>Paragraph ${n} about the ${word}: a long and careful explanation of how the ${word} lives, ` +
    `what it eats, where it sleeps and why people who bookmark pages about it keep coming back to read more.</p>`;
  return `<!doctype html><html><head><title>${word}</title></head><body><article><h1>${word}</h1>${[1, 2, 3, 4, 5, 6]
    .map(paragraph)
    .join("")}</article></body></html>`;
}

/**
 * A fake fetch shared by every fetcher: an article after `delayMs` (or, with
 * `fail`, a DNS failure, which has no text to extract), recording what was in flight.
 */
function fakeFetch(delayMs, { fail = false } = {}) {
  const calls = [];
  const domains = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  let sameDomainAtOnce = false;
  const fn = async (url, options) => {
    const domain = domainKey(url);
    const start = Date.now();
    calls.push({ url, domain, start, end: undefined });
    const call = calls[calls.length - 1];
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (domains.get(domain)) sameDomainAtOnce = true;
    domains.set(domain, true);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    inFlight--;
    domains.set(domain, false);
    call.end = Date.now();
    if (options.signal?.aborted) return { status: "failed", reason: "aborted", url };
    if (fail) return { status: "failed", reason: "dns", url };
    return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: article("numbat") };
  };
  return {
    fn,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    get sameDomainAtOnce() {
      return sameDomainAtOnce;
    },
  };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-fetch-pool-"));
  dirs.push(dir);
  return dir;
}

/** A bookmarks file's index with these URLs pending, in a directory of its own. */
function seededIndex(urls) {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  try {
    store.syncBookmarks(bookmarkRows(entries(urls)));
    store.addPendingPages();
  } finally {
    store.close();
  }
  return { dir, bookmarksFile, urls };
}

function fetcherFor(index, fetch, pool, options = {}) {
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => entries(index.urls),
    dir: index.dir,
    fetch: fetch.fn,
    pool,
    heartbeatMs: 60_000,
    ...options,
  });
  fetchers.push(fetcher);
  return fetcher;
}

function pageOf(index, url) {
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    return store.getPage(url);
  } finally {
    store.close();
  }
}

test("FetchPool: the concurrency limit and each domain's turn hold over every fetcher", async () => {
  const domains = ["a", "b", "c", "d", "e"];
  const one = seededIndex(domains.flatMap((d) => [`https://${d}.example/1`, `https://${d}.example/2`]));
  const two = seededIndex(domains.flatMap((d) => [`https://${d}.example/3`, `https://${d}.example/4`]));
  const fetch = fakeFetch(30);
  const pool = new FetchPool({ concurrency: 3, domainGapMs: 50 });
  const a = fetcherFor(one, fetch, pool);
  const b = fetcherFor(two, fetch, pool);
  try {
    a.start();
    b.start();
    await until(() => fetch.calls.length === 20 && a.status().state === "idle" && b.status().state === "idle", "every page");
  } finally {
    a.stop();
    b.stop();
  }
  assert.ok(fetch.maxInFlight <= 3, `${fetch.maxInFlight} fetches at once over two fetchers`);
  assert.equal(fetch.maxInFlight, 3, "the pool's slots are used");
  assert.equal(fetch.sameDomainAtOnce, false, "two fetches to one domain at once");
  for (const domain of domains) {
    const times = fetch.calls.filter((call) => call.domain === `${domain}.example`).sort((x, y) => x.start - y.start);
    for (let i = 1; i < times.length; i++) {
      // A timer may fire a millisecond early.
      assert.ok(times[i].start - times[i - 1].end >= 45, `${domain}: ${times[i].start - times[i - 1].end} ms between requests`);
    }
  }
  assert.equal(a.status().fetched, 10);
  assert.equal(b.status().fetched, 10);
});

test("FetchPool: a fetcher started later gets slots before the first one's queue drains", async () => {
  const one = seededIndex(Array.from({ length: 24 }, (_, i) => `https://one${i}.example/`));
  const two = seededIndex(Array.from({ length: 4 }, (_, i) => `https://two${i}.example/`));
  // Failures: no page text, so no extraction worker starting up skews one fetcher's turns.
  const fetch = fakeFetch(20, { fail: true });
  const pool = new FetchPool({ concurrency: 2, domainGapMs: 0 });
  const a = fetcherFor(one, fetch, pool);
  const b = fetcherFor(two, fetch, pool);
  let before;
  try {
    a.start();
    await until(() => fetch.calls.length >= 2, "the first fetcher to fill the pool");
    before = fetch.calls.length;
    b.start();
    await until(() => fetch.calls.length === 28 && a.status().state === "idle" && b.status().state === "idle", "every page");
  } finally {
    a.stop();
    b.stop();
  }
  const order = fetch.calls.map((call) => call.url);
  const lastOfTwo = Math.max(...two.urls.map((url) => order.indexOf(url)));
  // Taking turns, the second fetcher's 4 pages start within ~8 fetches of its start, not after the first's queue.
  assert.ok(lastOfTwo - before < 11, `the second fetcher's last page was fetch ${lastOfTwo - before + 1} after it started`);
  assert.ok(28 - before > 16, "the first fetcher had most of its queue left");
});

test("FetchPool: a URL in two bookmarks files is fetched once, the second index taking the page", async () => {
  const shared = "https://shared.example/numbat";
  const one = seededIndex([shared, "https://one.example/"]);
  const two = seededIndex([shared, "https://two.example/"]);
  const fetch = fakeFetch(20);
  const pool = new FetchPool({ concurrency: 4, domainGapMs: 0 });
  const pages = [];
  const a = fetcherFor(one, fetch, pool);
  const b = fetcherFor(two, fetch, pool, { onPage: (url) => pages.push(url) });
  try {
    a.start();
    b.start();
    await until(() => a.status().state === "idle" && b.status().state === "idle" && pageOf(two, shared)?.status === "ok", "every page");
  } finally {
    a.stop();
    b.stop();
  }
  assert.deepEqual(fetch.calls.filter((call) => call.url === shared).length, 1, "the shared URL fetched once");
  assert.equal(fetch.calls.length, 3);
  const first = pageOf(one, shared);
  const second = pageOf(two, shared);
  for (const page of [first, second]) {
    assert.equal(page.status, "ok");
    assert.match(page.text, /numbat/);
  }
  assert.equal(second.text, first.text);
  assert.equal(second.content_hash, first.content_hash);
  assert.equal(second.fetched_at, first.fetched_at);
  assert.equal(b.status().fetched, 2, "a page taken from the other index counts as fetched");
  assert.ok(pages.includes(shared), "the indexer hears of the taken page");
});

test("Fetcher: without a pool, each fetcher keeps its own limits", async () => {
  const one = seededIndex(["https://same.example/1", "https://same.example/2"]);
  const two = seededIndex(["https://same.example/3", "https://same.example/4"]);
  const fetch = fakeFetch(30);
  const a = fetcherFor(one, fetch, undefined, { concurrency: 1, domainGapMs: 0 });
  const b = fetcherFor(two, fetch, undefined, { concurrency: 1, domainGapMs: 0 });
  try {
    a.start();
    b.start();
    await until(() => fetch.calls.length === 4 && a.status().state === "idle" && b.status().state === "idle", "every page");
  } finally {
    a.stop();
    b.stop();
  }
  assert.equal(fetch.maxInFlight, 2, "two separate pools of one");
});

// --- adoptedRow -----------------------------------------------------------------

const NOW = 1_000_000_000_000;

/** A page row as IndexStore.getPage gives it. */
function row(fields) {
  return {
    url: "https://x.example/",
    status: "pending",
    final_url: null,
    fetched_at: null,
    fail_count: 0,
    next_attempt_at: null,
    content_hash: null,
    reason: null,
    text: null,
    ...fields,
  };
}

test("adoptedRow: another index's ok page, fetched lately, is taken whole", () => {
  const theirs = row({
    status: "ok",
    final_url: "https://x.example/final",
    fetched_at: NOW - 1000,
    next_attempt_at: NOW - 1000 + REFRESH_MS,
    content_hash: "abc",
    text: "the text",
  });
  const previous = row({ status: "failed", fail_count: 2, fetched_at: NOW - SHARED_FRESH_MS * 3 });
  assert.deepEqual(adoptedRow(theirs, previous, false, NOW), {
    url: "https://x.example/",
    status: "ok",
    final_url: "https://x.example/final",
    fetched_at: NOW - 1000,
    fail_count: 0,
    next_attempt_at: NOW - 1000 + REFRESH_MS,
    content_hash: "abc",
    reason: null,
    text: "the text",
  });
  assert.equal(adoptedRow(theirs, previous, true, NOW)?.status, "ok", "a page waiting for the browser takes it too");
});

test("adoptedRow: a page fetched too long ago, never, or not after this index's own fetch is fetched here", () => {
  const ok = { status: "ok", text: "t", content_hash: "h" };
  assert.equal(adoptedRow(row({ ...ok, fetched_at: NOW - SHARED_FRESH_MS - 1 }), row({}), false, NOW), undefined);
  assert.equal(adoptedRow(row({ ...ok, fetched_at: null }), row({}), false, NOW), undefined);
  assert.equal(adoptedRow(row({ ...ok, fetched_at: NOW - 50 }), row({ status: "ok", fetched_at: NOW - 50 }), false, NOW), undefined);
  assert.equal(adoptedRow(row({ ...ok, fetched_at: NOW - 50 }), row({ status: "ok", fetched_at: NOW - 10 }), false, NOW), undefined);
  assert.equal(adoptedRow(row({ status: "pending" }), row({}), false, NOW), undefined);
});

test("adoptedRow: a failure counts as this index's own, backing off from its own fail count", () => {
  const theirs = row({ status: "failed", fetched_at: NOW - 100, fail_count: 1, next_attempt_at: NOW - 100 + backoffMs(1), reason: "http: HTTP 500" });
  const adopted = adoptedRow(theirs, row({ status: "failed", fail_count: 3, fetched_at: NOW - 10 * SHARED_FRESH_MS }), false, NOW);
  assert.equal(adopted.status, "failed");
  assert.equal(adopted.fail_count, 4);
  assert.equal(adopted.next_attempt_at, NOW - 100 + backoffMs(4));
  assert.equal(adopted.reason, "http: HTTP 500");
});

test("adoptedRow: needs_browser goes to this index's browser queue; skips from the skip lists are not taken", () => {
  const shell = row({ status: "needs_browser", fetched_at: NOW - 100, reason: "too short" });
  const previous = row({ status: "failed", fail_count: 2, fetched_at: NOW - 10 * SHARED_FRESH_MS });
  assert.deepEqual(
    { ...adoptedRow(shell, previous, false, NOW) },
    { ...shell, fail_count: 2, next_attempt_at: null },
  );
  assert.equal(adoptedRow(shell, previous, true, NOW), undefined, "a page waiting for the browser renders it itself");
  const listSkip = row({ status: "skipped", fetched_at: NOW - 100, reason: "skip-folder", next_attempt_at: null });
  assert.equal(adoptedRow(listSkip, row({}), false, NOW), undefined);
  const fetchSkip = row({ status: "skipped", fetched_at: NOW - 100, reason: "private-address", next_attempt_at: NOW + REFRESH_MS });
  assert.equal(adoptedRow(fetchSkip, row({}), false, NOW)?.status, "skipped");
  const login = row({ status: "needs_login", fetched_at: NOW - 100, reason: "password field", next_attempt_at: NOW + REFRESH_MS });
  assert.equal(adoptedRow(login, row({}), false, NOW)?.status, "needs_login");
});
