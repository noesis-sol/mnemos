// The fetch queue's order (dist/fetcher.js, dist/index-store.js): pages never
// fetched go ahead of refreshes and retries that are due, newest bookmark first
// within each; and a bookmark added while a long queue of refreshes drains is
// fetched at the next heartbeat, not after the queue.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher } from "../dist/fetcher.js";

const dirs = [];
after(() => {
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
    await sleep(20);
  }
}

const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

/** Entries as lib.allBookmarks gives them: [url, added]. */
function entries(list) {
  return list.map(([url, added]) => ({
    folder: "Bookmarks Bar",
    node: { type: "url", name: url, url, date_added: chromeTime(added) },
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

/** A fake fetch: an article after `delayMs`, recording the URLs in the order fetched. */
function fakeFetch(delayMs) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push(url);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (options.signal?.aborted) return { status: "failed", reason: "aborted", url };
    return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: article("numbat") };
  };
  return { fn, calls };
}

/**
 * An index with these bookmarks; `fetched` URLs are ok pages whose 30-day
 * refresh is due, `retry` URLs failed pages whose retry is due, the rest pending.
 */
function seededIndex(list, { fetched = [], retry = [] } = {}) {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  try {
    store.syncBookmarks(bookmarkRows(entries(list)));
    store.addPendingPages();
    for (const url of fetched) store.upsertPage({ url, status: "ok", fetched_at: 1, next_attempt_at: 1, text: "old" });
    for (const url of retry) store.upsertPage({ url, status: "failed", fail_count: 1, next_attempt_at: 1 });
  } finally {
    store.close();
  }
  return { dir, bookmarksFile };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-fetch-queue-"));
  dirs.push(dir);
  return dir;
}

test("store: duePages lists pending pages first, then refreshes and retries due", () => {
  const list = [
    ["https://a.example/", 1],
    ["https://b.example/", 2],
    ["https://c.example/", 3],
    ["https://d.example/", 4],
  ];
  const index = seededIndex(list, { fetched: ["https://a.example/"], retry: ["https://b.example/"] });
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    store.upsertPage({ url: "https://c.example/", status: "ok", next_attempt_at: 500, text: "fresh" });
    assert.deepEqual(store.duePages(100), [
      { url: "https://d.example/", pending: true },
      { url: "https://a.example/", pending: false },
      { url: "https://b.example/", pending: false },
    ]);
  } finally {
    store.close();
  }
});

test("Fetcher: new bookmarks go before the refreshes and retries due, newest first in each", async () => {
  // The refreshes and the retry are newer bookmarks than the two never fetched.
  const list = [
    ["https://new1.example/", 1],
    ["https://new2.example/", 2],
    ["https://old3.example/", 3],
    ["https://old4.example/", 4],
    ["https://retry5.example/", 5],
  ];
  const index = seededIndex(list, {
    fetched: ["https://old3.example/", "https://old4.example/"],
    retry: ["https://retry5.example/"],
  });
  const fetch = fakeFetch(5);
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => entries(list),
    dir: index.dir,
    fetch: fetch.fn,
    concurrency: 1,
    domainGapMs: 0,
    heartbeatMs: 60_000,
  });
  try {
    fetcher.start();
    await until(() => fetch.calls.length === list.length && fetcher.status().state === "idle", "every page");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(fetch.calls, [
    "https://new2.example/",
    "https://new1.example/",
    "https://retry5.example/",
    "https://old4.example/",
    "https://old3.example/",
  ]);
});

test("Fetcher: a bookmark added while refreshes drain is fetched at the next heartbeat", async () => {
  const refreshes = Array.from({ length: 30 }, (_, i) => [`https://r${i}.example/`, i]);
  const list = [...refreshes];
  const index = seededIndex(list, { fetched: refreshes.map(([url]) => url) });
  const fetch = fakeFetch(40);
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => entries(list),
    dir: index.dir,
    fetch: fetch.fn,
    concurrency: 1,
    domainGapMs: 0,
    heartbeatMs: 50,
  });
  try {
    fetcher.start();
    await until(() => fetch.calls.length >= 2, "the refreshes to start");
    // The title indexer syncs the new bookmark into the index, an old one at that.
    list.push(["https://added.example/", -1]);
    const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
    try {
      store.syncBookmarks(bookmarkRows(entries(list)));
    } finally {
      store.close();
    }
    const before = fetch.calls.length;
    await until(() => fetch.calls.includes("https://added.example/"), "the new bookmark");
    assert.ok(fetch.calls.indexOf("https://added.example/") - before <= 5, `fetched after ${fetch.calls.length - before} more`);
    assert.ok(fetch.calls.length < list.length, "before the refreshes ran out");
  } finally {
    fetcher.stop();
  }
});
