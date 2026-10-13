// Keeping the index fresh, in process with an injected clock: the page fetcher
// (dist/fetcher.js) with a fake fetch and the indexer (dist/indexer.js) with a
// counting fake embedder, on one index. An ok page is fetched again after 30
// days and not before, and embedded again only when its text changed; a failing
// page backs off 1 h, 6 h, 1 d, 7 d, then 30 d, its fail_count kept; needs_login
// and skipped pages wait 30 days or for a policy change, and a page the fetch
// skipped after a redirect is not fetched over and over; a deleted bookmark's
// page and chunks go, unless its URL is still bookmarked elsewhere; skip-list
// edits move pages between skipped (chunks dropped) and pending.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { BACKOFF_STEPS_MS, Fetcher, REFRESH_MS } from "../dist/fetcher.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const dirs = [];
// Every test stops its fetcher and closes its indexer first; a directory that will not go is let be.
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
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

class CountingEmbedder extends FakeEmbedder {
  texts = [];
  async embed(texts, kind) {
    this.texts.push(...texts);
    return super.embed(texts, kind);
  }
}

function article(word) {
  const paragraph = (n) =>
    `<p>Paragraph ${n} about the ${word}: a long and careful explanation of how the ${word} lives, ` +
    `what it eats, where it sleeps and why people who bookmark pages about it keep coming back to read more.</p>`;
  return `<!doctype html><html><head><title>${word}</title></head><body><article><h1>${word}</h1>${[1, 2, 3, 4, 5, 6]
    .map(paragraph)
    .join("")}</article></body></html>`;
}

const LOGIN = `<!doctype html><html><body><form><input type="password" name="p"></form></body></html>`;

/** Entries as lib.allBookmarks gives them: [url, folder, guid]. */
function entries(list) {
  return list.map(([url, folder, guid]) => ({ folder, node: { type: "url", name: `Title of ${url}`, url, guid } }));
}

/**
 * A fetcher and an indexer on one index, with a clock the test moves. `site`
 * maps each URL to what the fake fetch answers: { word } an article,
 * "login" a login wall, "error" an HTTP 500, or any other outcome as given.
 */
function harness(list, site, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-freshness-"));
  dirs.push(dir);
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const h = {
    clock: Date.UTC(2026, 0, 1),
    list,
    site,
    calls: [],
    embedder: new CountingEmbedder(),
    fetcher: undefined,
    indexer: undefined,
  };
  const now = () => h.clock;
  const fetch = async (url) => {
    h.calls.push(url);
    await sleep(1);
    const answer = h.site[url];
    const html = (body) => ({ status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: body });
    if (answer === "login") return html(LOGIN);
    if (answer === "error") return { status: "failed", reason: "http-error", httpStatus: 500, url };
    if (answer.word) return html(article(answer.word));
    return answer;
  };
  h.indexer = new Indexer({ embedder: h.embedder, bookmarksFile: () => bookmarksFile, entries: () => entries(h.list), dir, debounceMs: 5, now });
  h.startFetcher = (fetchEnv = env) => {
    h.fetcher?.stop();
    h.fetcher = new Fetcher({
      env: fetchEnv,
      bookmarksFile: () => bookmarksFile,
      entries: () => entries(h.list),
      dir,
      fetch,
      domainGapMs: 0,
      heartbeatMs: 60_000,
      idlePollMs: 10,
      now,
      onPage: () => h.indexer.pagesChanged(),
    });
    h.fetcher.start();
  };
  h.read = (fn) => {
    const store = IndexStore.open({ bookmarksFile, dir });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  h.page = (url) => h.read((s) => s.getPage(url));
  h.chunks = (url) => h.read((s) => s.getChunks(url));
  /** Waits until `check` holds and the fetcher and indexer have nothing left to do. */
  h.settle = async (check, what) => {
    await until(() => check() && h.fetcher.status().state === "idle", what);
    await h.fetcher.idle();
    await h.indexer.idle();
  };
  /** Gives the fetcher several polls at the current clock; returns the URLs it fetched meanwhile. */
  h.quiet = async () => {
    const before = h.calls.length;
    await sleep(120);
    await h.fetcher.idle();
    await h.indexer.idle();
    return h.calls.slice(before);
  };
  h.close = () => {
    h.fetcher?.stop();
    h.indexer.close();
  };
  return h;
}

/** Indexes the titles, starts fetching, and waits until every URL of `urls` has a fetched page. */
async function firstPass(h, urls) {
  h.indexer.start();
  await h.indexer.idle();
  h.startFetcher();
  await h.settle(() => urls.every((url) => h.page(url)?.fetched_at != null), "the first pass");
}

test("freshness: an ok page is fetched again after 30 days, and embedded again only if its text changed", async () => {
  const [a, b] = ["https://a.example/", "https://b.example/"];
  const h = harness([[a, "Bar", "g-a"], [b, "Bar", "g-b"]], { [a]: { word: "aardvark" }, [b]: { word: "bilby" } });
  try {
    await firstPass(h, [a, b]);
    const start = h.clock;
    assert.equal(h.page(a).status, "ok");
    assert.equal(h.page(a).next_attempt_at, start + REFRESH_MS);
    const chunksA = h.chunks(a);
    assert.ok(chunksA.length > 0 && chunksA.every((c) => c.vector !== null));
    assert.deepEqual([...h.calls].sort(), [a, b]);

    // 29 days on: nothing is due.
    h.clock = start + 29 * DAY;
    assert.deepEqual(await h.quiet(), []);

    // 31 days on: both are fetched again; a's text is the same, b's changed.
    h.clock = start + 31 * DAY;
    h.site[b] = { word: "bandicoot" };
    h.embedder.texts = [];
    await h.settle(() => h.page(a).fetched_at === h.clock && h.page(b).fetched_at === h.clock, "the re-fetch");
    assert.equal(h.calls.filter((url) => url === a).length, 2);
    assert.equal(h.calls.filter((url) => url === b).length, 2);
    assert.equal(h.page(a).next_attempt_at, h.clock + REFRESH_MS);
    assert.ok(h.embedder.texts.length > 0, "b's new text is embedded");
    assert.ok(h.embedder.texts.every((t) => /bandicoot/.test(t) && !/aardvark/.test(t)), "a's unchanged text is not");
    assert.deepEqual(h.chunks(a), chunksA, "a's chunks and vectors are kept as they were");
    assert.ok(h.chunks(b).every((c) => /bandicoot/.test(c.text) && c.vector !== null));
  } finally {
    h.close();
  }
});

test("freshness: a failing page backs off 1 h, 6 h, 1 d, 7 d, then every 30 d, keeping its fail_count", async () => {
  const url = "https://down.example/";
  const h = harness([[url, "Bar", "g-down"]], { [url]: "error" });
  try {
    await firstPass(h, [url]);
    assert.deepEqual(BACKOFF_STEPS_MS, [HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY]);
    const waits = [HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY, 30 * DAY];
    for (const [i, wait] of waits.entries()) {
      const page = h.page(url);
      assert.equal(page.status, "failed");
      assert.equal(page.fail_count, i + 1);
      assert.equal(page.next_attempt_at, page.fetched_at + wait, `after failure ${i + 1}`);
      // A minute early: not retried.
      h.clock = page.next_attempt_at - 60_000;
      assert.deepEqual(await h.quiet(), [], `a minute before retry ${i + 1}`);
      h.clock = page.next_attempt_at;
      await h.settle(() => h.page(url).fail_count === i + 2, `retry ${i + 1}`);
    }
    // It comes back: ok, and the count starts over.
    h.site[url] = { word: "dingo" };
    h.clock = h.page(url).next_attempt_at;
    await h.settle(() => h.page(url).status === "ok", "the recovery");
    assert.equal(h.page(url).fail_count, 0);
    assert.ok(h.chunks(url).length > 0);
  } finally {
    h.close();
  }
});

test("freshness: needs_login and skipped pages wait 30 days or for a policy change; a redirect's skip is not a loop", async () => {
  const login = "https://login.example/";
  const redirected = "https://moved.example/";
  const site = {
    [login]: "login",
    // The fetch followed a redirect to a skipped domain: the page's own URL is not on the list.
    [redirected]: { status: "skipped", reason: "skip-domain", url: "https://blocked.example/" },
  };
  const env = { MNEMOS_SKIP_DOMAINS: "blocked.example" };
  const h = harness([[login, "Bar", "g-login"], [redirected, "Bar", "g-moved"]], site, env);
  try {
    await firstPass(h, [login, redirected]);
    const start = h.clock;
    assert.equal(h.page(login).status, "needs_login");
    assert.equal(h.page(redirected).status, "skipped");
    assert.equal(h.page(redirected).reason, "skip-domain");
    assert.deepEqual([...h.calls].sort(), [login, redirected]);

    // Many polls later, 29 days on, the same policy: neither is fetched again.
    h.clock = start + 29 * DAY;
    assert.deepEqual(await h.quiet(), []);

    // The policy changes (another domain skipped): both are due at once, and fetched once.
    h.startFetcher({ MNEMOS_SKIP_DOMAINS: "blocked.example,elsewhere.example" });
    await h.settle(() => h.page(login).fetched_at === h.clock && h.page(redirected).fetched_at === h.clock, "the policy change");
    assert.deepEqual(h.calls.slice(2).sort(), [login, redirected]);
    assert.deepEqual(await h.quiet(), [], "and not again");

    // 30 days after that: fetched once more, under the same policy.
    const changed = h.clock;
    h.clock = changed + REFRESH_MS;
    await h.settle(() => h.page(login).fetched_at === h.clock && h.page(redirected).fetched_at === h.clock, "30 days on");
    assert.equal(h.calls.length, 6);
    assert.deepEqual(await h.quiet(), []);
  } finally {
    h.close();
  }
});

test("freshness: a deleted bookmark's page and chunks go, unless its URL is still bookmarked elsewhere", async () => {
  const [gone, kept] = ["https://gone.example/", "https://kept.example/"];
  const h = harness(
    [[gone, "Bar", "g-gone"], [kept, "Bar", "g-kept-1"], [kept, "Bar › Copies", "g-kept-2"]],
    { [gone]: { word: "quokka" }, [kept]: { word: "wombat" } },
  );
  try {
    await firstPass(h, [gone, kept]);
    assert.ok(h.chunks(gone).length > 0);
    assert.ok(h.chunks(kept).length > 0);

    // gone's only bookmark and one of kept's two are deleted.
    h.list = [[kept, "Bar › Copies", "g-kept-2"]];
    h.indexer.start();
    await h.indexer.idle();
    assert.equal(h.page(gone), undefined);
    assert.deepEqual(h.chunks(gone), []);
    assert.deepEqual(h.read((s) => s.bookmarkGuids()), ["g-kept-2"]);
    assert.equal(h.page(kept).status, "ok");
    assert.ok(h.chunks(kept).length > 0 && h.chunks(kept).every((c) => c.vector !== null));

    // Nor is the deleted page fetched again, even once its refresh is due.
    h.clock += 31 * DAY;
    await h.settle(() => h.page(kept).fetched_at === h.clock, "kept's refresh");
    assert.deepEqual(h.calls.filter((url) => url === gone), [gone]);
  } finally {
    h.close();
  }
});

test("freshness: skip-list edits move pages to skipped, dropping their chunks, and back to pending", async () => {
  const [bank, news, blog] = ["https://bank.example/", "https://news.example/", "https://blog.example/"];
  const h = harness(
    [[bank, "Bar › Money", "g-bank"], [news, "Bar", "g-news"], [blog, "Bar", "g-blog"]],
    { [bank]: { word: "ledger" }, [news]: { word: "headline" }, [blog]: { word: "musing" } },
  );
  try {
    await firstPass(h, [bank, news, blog]);
    for (const url of [bank, news, blog]) assert.ok(h.chunks(url).length > 0, url);

    // The Money folder and news.example are skipped now: their text and chunks go, and they are not fetched.
    h.startFetcher({ MNEMOS_SKIP_FOLDERS: "money", MNEMOS_SKIP_DOMAINS: "news.example" });
    await h.settle(() => h.page(bank).status === "skipped" && h.page(news).status === "skipped", "the skips");
    assert.equal(h.page(bank).reason, "skip-folder");
    assert.equal(h.page(news).reason, "skip-domain");
    for (const url of [bank, news]) {
      assert.equal(h.page(url).text, null);
      assert.deepEqual(h.chunks(url), [], url);
    }
    assert.ok(h.chunks(blog).length > 0, "blog is not touched");
    h.clock += 31 * DAY;
    await h.settle(() => h.page(blog).fetched_at === h.clock, "blog's refresh");
    assert.deepEqual(h.calls.slice(3), [blog], "skipped pages are not fetched, even 31 days on");

    // news.example is allowed again: pending, fetched, chunked and embedded again. The folder is still skipped.
    h.startFetcher({ MNEMOS_SKIP_FOLDERS: "money" });
    await h.settle(() => h.page(news).status === "ok" && h.chunks(news).every((c) => c.vector !== null), "news again");
    assert.ok(h.chunks(news).length > 0);
    assert.equal(h.page(bank).status, "skipped");
    assert.deepEqual(h.calls.slice(4), [news]);

    // The bookmark leaves the skipped folder: pending and fetched again, with no policy change.
    h.list = [[bank, "Bar", "g-bank"], [news, "Bar", "g-news"], [blog, "Bar", "g-blog"]];
    await h.settle(() => h.page(bank).status === "ok", "bank again");
    assert.deepEqual(h.calls.slice(5), [bank]);
  } finally {
    h.close();
  }
});
