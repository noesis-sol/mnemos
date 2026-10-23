// The extraction worker dying mid-page (dist/extract.js, dist/fetcher.js): the
// Extractor fails the page it was extracting, and every page waiting behind it,
// with the worker's exit code, and the next extract() starts a fresh worker; a
// Fetcher whose worker dies records that page failed with backoff and fetches
// the next page normally. The worker is killed with terminate() a moment into
// a large page, which takes it most of a second to read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher, backoffMs } from "../dist/fetcher.js";
import { Extractor } from "../dist/extract.js";

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
    await sleep(10);
  }
}

/** Rejects if `promise` has not settled within `ms`: a page left waiting on a dead worker. */
function within(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const EXITED = /^the extraction worker exited with code \d+$/;

function article(word) {
  const paragraph = (n) =>
    `<p>Paragraph ${n} about the ${word}: a long and careful explanation of how the ${word} lives, ` +
    `what it eats, where it sleeps and why people who bookmark pages about it keep coming back to read more.</p>`;
  return `<!doctype html><html><head><title>${word}</title></head><body><article><h1>${word}</h1>${[1, 2, 3, 4, 5, 6]
    .map(paragraph)
    .join("")}</article></body></html>`;
}

/** A 3 MB article: hundreds of milliseconds of work for the worker. */
function bigArticle(word) {
  return article(word).replace(
    "</article>",
    `${Array.from({ length: 50_000 }, (_, i) => `<p>Note ${i} on the ${word}, with a few more words to read.</p>`).join("")}</article>`,
  );
}

/** Terminates the Extractor's worker `delayMs` from now, once it is reading a page. */
function killWorkerSoon(extractor, delayMs = 30) {
  const worker = extractor.worker;
  assert.ok(worker, "the extractor has a worker");
  setTimeout(() => void worker.terminate(), delayMs);
  return worker;
}

test("Extractor: the worker dying mid-page fails that page, and the next page gets a fresh worker", { timeout: 60_000 }, async () => {
  const extractor = new Extractor();
  try {
    // The worker up and its modules loaded, so it dies reading the page, not starting.
    assert.equal((await extractor.extract(article("tapir"), "https://example.com/tapir")).status, "ok");
    const page = extractor.extract(bigArticle("okapi"), "https://example.com/okapi");
    const dead = killWorkerSoon(extractor);
    await assert.rejects(within(page, 20_000, "the page"), { message: EXITED });
    assert.equal(extractor.waiting.size, 0, "nothing left waiting");
    assert.equal(extractor.worker, undefined, "the dead worker is let go");

    const next = await extractor.extract(article("quokka"), "https://example.com/quokka");
    assert.equal(next.status, "ok");
    assert.match(next.text, /quokka/);
    assert.ok(extractor.worker && extractor.worker !== dead, "a fresh worker");
  } finally {
    extractor.close();
  }
});

test("Extractor: every page waiting on a worker that dies fails, and none hangs", { timeout: 60_000 }, async () => {
  const extractor = new Extractor();
  try {
    assert.equal((await extractor.extract(article("tapir"), "https://example.com/tapir")).status, "ok");
    // One page being read, three queued behind it in the worker.
    const pages = [
      extractor.extract(bigArticle("okapi"), "https://example.com/okapi"),
      extractor.extract(article("axolotl"), "https://example.com/axolotl"),
      extractor.extract(bigArticle("pangolin"), "https://example.com/pangolin"),
      extractor.extract(article("numbat"), "https://example.com/numbat"),
    ];
    assert.equal(extractor.waiting.size, pages.length);
    killWorkerSoon(extractor);
    const settled = await within(Promise.allSettled(pages), 20_000, "the waiting pages");
    for (const [i, outcome] of settled.entries()) {
      assert.equal(outcome.status, "rejected", `page ${i} failed`);
      assert.match(outcome.reason.message, EXITED);
    }
    assert.equal(extractor.waiting.size, 0, "nothing left waiting");
    assert.equal((await extractor.extract(article("quokka"), "https://example.com/quokka")).status, "ok");
  } finally {
    extractor.close();
  }
});

// --- the fetcher ---------------------------------------------------------------

const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

/** Entries as lib.allBookmarks gives them, from URLs, the first the newest. */
function entries(urls) {
  return urls.map((url, i) => ({
    folder: "Bookmarks Bar",
    node: { type: "url", name: url, url, date_added: chromeTime(urls.length - i) },
  }));
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-extract-crash-"));
  dirs.push(dir);
  return dir;
}

/** A bookmarks file's index with these URLs pending. */
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

function pageOf(index, url) {
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    return store.getPage(url);
  } finally {
    store.close();
  }
}

test("Fetcher: a page whose extraction worker dies is failed with backoff, and the next page is fetched normally", { timeout: 60_000 }, async () => {
  // Fetched newest first: one page to start the worker, the page it dies on, the page after.
  const [first, dying, next] = ["https://a.example/first", "https://b.example/dying", "https://c.example/next"];
  const index = seededIndex([first, dying, next]);
  const pages = { [first]: article("tapir"), [dying]: bigArticle("okapi"), [next]: article("quokka") };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const html = pages[url];
    return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html };
  };
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => entries(index.urls),
    dir: index.dir,
    fetch,
    concurrency: 1,
    domainGapMs: 0,
    heartbeatMs: 60_000,
  });
  // The worker is killed a moment into the dying page's extraction.
  const extractor = fetcher.extractor;
  const extract = extractor.extract.bind(extractor);
  const workers = [];
  extractor.extract = (html, url) => {
    const page = extract(html, url);
    workers.push(extractor.worker);
    if (url === dying) killWorkerSoon(extractor);
    return page;
  };
  const started = Date.now();
  try {
    fetcher.start();
    await until(() => calls.length === 3 && fetcher.status().state === "idle", "every page");
  } finally {
    fetcher.stop();
  }
  const finished = Date.now();
  assert.deepEqual(calls, [first, dying, next], "each page fetched once, in order");

  const failed = pageOf(index, dying);
  assert.equal(failed.status, "failed");
  assert.equal(failed.fail_count, 1);
  assert.match(failed.reason, /^extraction failed: the extraction worker exited with code \d+$/);
  assert.equal(failed.text, null);
  const wait = failed.next_attempt_at - backoffMs(1);
  assert.ok(wait >= started && wait <= finished, "retried after the first failure's backoff");

  for (const [url, word] of [[first, "tapir"], [next, "quokka"]]) {
    const page = pageOf(index, url);
    assert.equal(page.status, "ok", url);
    assert.equal(page.fail_count, 0, url);
    assert.match(page.text, new RegExp(word), url);
  }
  assert.equal(workers[0], workers[1], "the dying page went to the worker that read the first");
  assert.notEqual(workers[2], workers[1], "the next page went to a fresh worker");
  assert.equal(fetcher.status().error, undefined, "the fetcher itself did not fail");
});
