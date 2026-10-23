// An ok page whose refreshes go shell, failed, shell (a site turned app that
// is down for a while, or a render that fails), in process with an injected
// clock: the page fetcher (dist/fetcher.js) with a fake fetch and a fake
// renderer, and the indexer (dist/indexer.js) with a counting fake embedder,
// on one index. A failed fetch keeps the text the page had, so the shell
// after it still keeps the page's chunks until a browser has had the last word.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { adoptedRow, backoffMs, Fetcher, keptText, SHARED_FRESH_MS } from "../dist/fetcher.js";

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

const SHELL = '<!doctype html><html><head></head><body><div id="root"></div><script>render()</script></body></html>';

/** What a site answers: { word } an article, "shell" a JavaScript shell, "down" a network error. */
function answer(url, what) {
  if (what === "down") return { status: "failed", reason: "connection", url, detail: "ECONNRESET" };
  const body = what === "shell" ? SHELL : article(what.word);
  return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: body };
}

const URL_A = "https://app.example/post";

/**
 * A fetcher and an indexer on one index, with a clock the test moves. The
 * fake fetch answers `h.site`; the renderer answers `h.rendered`'s, or, with
 * `browser: false`, reports no browser.
 */
function harness({ browser }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-failed-between-shells-"));
  dirs.push(dir);
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const list = [{ folder: "Bar", node: { type: "url", name: "A post", url: URL_A, guid: "g-a" } }];
  const h = {
    clock: Date.UTC(2026, 0, 1),
    site: { word: "aardvark" },
    rendered: { word: "aardvark" },
    renders: [],
    embedder: new CountingEmbedder(),
  };
  const now = () => h.clock;
  const renderer = {
    launch: async () =>
      browser ? { ok: true } : { ok: false, reason: "no Chromium-based browser found", hint: "set MNEMOS_BROWSER" },
    render: async (url) => {
      h.renders.push(url);
      await sleep(1);
      return answer(url, h.rendered);
    },
    close: async () => {},
  };
  h.indexer = new Indexer({ embedder: h.embedder, bookmarksFile: () => bookmarksFile, entries: () => list, dir, debounceMs: 5, now });
  h.fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => bookmarksFile,
    entries: () => list,
    dir,
    fetch: async (url) => {
      await sleep(1);
      return answer(url, h.site);
    },
    renderer,
    domainGapMs: 0,
    heartbeatMs: 60_000,
    idlePollMs: 10,
    now,
    onPage: () => h.indexer.pagesChanged(),
  });
  h.read = (fn) => {
    const store = IndexStore.open({ bookmarksFile, dir });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  h.page = () => h.read((s) => s.getPage(URL_A));
  h.chunks = () => h.read((s) => s.getChunks(URL_A));
  h.settle = async (check, what) => {
    await until(() => check() && h.fetcher.status().state === "idle", what);
    await h.fetcher.idle();
    await h.indexer.idle();
    await h.indexer.idle();
  };
  /** Moves the clock to the page's next attempt, `site` answering, and waits for the fetch. */
  h.next = async (site, at, what) => {
    h.site = site;
    h.clock = at;
    await h.settle(() => h.page().fetched_at === at, what);
    return h.page();
  };
  h.close = () => {
    h.fetcher.stop();
    h.indexer.close();
  };
  return h;
}

/** The first fetch: an article, ok and embedded. */
async function okFirst(h) {
  h.indexer.start();
  await h.indexer.idle();
  h.fetcher.start();
  await h.settle(() => h.page()?.status === "ok" && h.chunks().length > 0 && h.chunks().every((c) => c.vector !== null), "the first fetch");
  const first = { page: h.page(), chunks: h.chunks() };
  h.embedder.texts = [];
  return first;
}

test("no browser: shell, a network error, shell again: the page keeps its text and chunks throughout", async () => {
  const h = harness({ browser: false });
  try {
    const first = await okFirst(h);
    h.site = "shell";
    h.clock = first.page.next_attempt_at;
    await h.settle(() => h.page().fetched_at === h.clock && h.fetcher.browserNote(), "the shell refresh");
    let page = h.page();
    assert.equal(page.status, "needs_browser");
    const fails = page.fail_count;

    // Fetched plainly again on a failed page's backoff, and the site is down.
    page = await h.next("down", page.fetched_at + backoffMs(fails), "the failed fetch");
    assert.equal(page.status, "failed");
    assert.equal(page.fail_count, fails + 1);
    assert.equal(page.content_hash, first.page.content_hash, "the failed fetch keeps the text it had");
    assert.equal(page.text, first.page.text);
    assert.deepEqual(h.chunks(), first.chunks, "chunks kept while it fails");

    page = await h.next("shell", page.next_attempt_at, "the second shell");
    assert.equal(page.status, "needs_browser");
    assert.equal(page.fail_count, fails + 2);
    assert.equal(page.content_hash, first.page.content_hash, "the second shell keeps the text too");
    assert.equal(page.text, first.page.text);
    assert.deepEqual(h.chunks(), first.chunks, "chunks and vectors kept as they were, with no browser having read the page");
    assert.deepEqual(h.embedder.texts, [], "nothing embedded again");
    assert.deepEqual(h.renders, [], "never rendered");
  } finally {
    h.close();
  }
});

test("a browser whose render fails, then a shell again: the chunks stay until a render reads the page", async () => {
  const h = harness({ browser: true });
  try {
    const first = await okFirst(h);
    h.rendered = "down";
    h.site = "shell";
    h.clock = first.page.next_attempt_at;
    await h.settle(() => h.renders.length === 1 && h.page().status === "failed", "the failing render");
    let page = h.page();
    assert.equal(page.content_hash, first.page.content_hash, "the failed render keeps the text it had");
    assert.deepEqual(h.chunks(), first.chunks);

    // The retry gets the shell again, and the browser renders the same text: nothing cut or embedded again.
    h.rendered = { word: "aardvark" };
    h.clock = page.next_attempt_at;
    await h.settle(() => h.renders.length === 2 && h.page().status === "ok", "the second render");
    page = h.page();
    assert.equal(page.content_hash, first.page.content_hash);
    assert.deepEqual(h.chunks(), first.chunks, "chunks and vectors kept as they were");
    assert.deepEqual(h.embedder.texts, [], "nothing embedded again");
  } finally {
    h.close();
  }
});

/** A page row as IndexStore.getPage gives it. */
function row(fields) {
  return {
    url: URL_A,
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

test("keptText: a failed row's kept text is kept again", () => {
  assert.deepEqual(keptText(row({ status: "failed", fail_count: 2, content_hash: "h", text: "t" })), { content_hash: "h", text: "t" });
  assert.deepEqual(keptText(row({ status: "failed", fail_count: 1 })), {});
});

test("adoptedRow: another index's failed page keeps this one's text, or takes the text theirs kept", () => {
  const NOW = Date.UTC(2026, 0, 1);
  const theirs = row({ status: "failed", fetched_at: NOW - 100, fail_count: 1, next_attempt_at: NOW + 1000, reason: "connection" });
  const previous = row({ status: "needs_browser", fetched_at: NOW - SHARED_FRESH_MS * 40, content_hash: "h", text: "the text" });
  const adopted = adoptedRow(theirs, previous, false, NOW);
  assert.equal(adopted.status, "failed");
  assert.equal(adopted.content_hash, "h");
  assert.equal(adopted.text, "the text");
  assert.equal(adoptedRow(theirs, row({ status: "pending" }), false, NOW).content_hash, null);
  const theirsKept = { ...theirs, content_hash: "h2", text: "their text" };
  assert.equal(adoptedRow(theirsKept, previous, false, NOW).content_hash, "h2");
});

test("store: a failed page with kept text is left as it is, chunks and all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-failed-between-shells-store-"));
  dirs.push(dir);
  const s = IndexStore.open({ bookmarksFile: path.join(dir, "Bookmarks"), dir });
  try {
    s.upsertBookmarks([{ guid: "g", url: URL_A, title: "T", folder_path: "Bar", text_hash: "t" }]);
    s.upsertPage({ url: URL_A, status: "ok", content_hash: "h1", text: "one" });
    s.replaceChunks(URL_A, ["one"], "h1");
    s.upsertPage({ url: URL_A, status: "failed", fail_count: 1, content_hash: "h1", text: "one" });
    assert.deepEqual(s.pagesToChunk(), []);
    s.upsertPage({ url: URL_A, status: "needs_browser", fail_count: 2, content_hash: "h1", text: "one" });
    assert.deepEqual(s.pagesToChunk(), [], "the shell after it keeps the chunks");
    assert.equal(s.getChunks(URL_A).length, 1);
  } finally {
    s.close();
  }
});
