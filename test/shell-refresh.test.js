// An ok page whose 30-day refresh comes back a JavaScript shell (a site turned
// app, or a bot check that day), in process with an injected clock: the page
// fetcher (dist/fetcher.js) with a fake fetch and a fake renderer, and the
// indexer (dist/indexer.js) with a counting fake embedder, on one index. The
// page keeps its text and chunks until the browser has had the last word: the
// browser's text replaces them only if it differs, and its no_content drops
// them. With no browser the page is fetched plainly again on a failed page's
// backoff, and is ok again once the site serves its text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeEmbedder } from "../dist/embedder.js";
import { IndexStore } from "../dist/index-store.js";
import { Indexer } from "../dist/indexer.js";
import { adoptedRow, backoffMs, Fetcher, keptText, REFRESH_MS, SHARED_FRESH_MS } from "../dist/fetcher.js";

const HOUR = 60 * 60_000;

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

const html = (url, body) => ({ status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: body });

/** What a site answers: { word } an article, "shell" a JavaScript shell. */
const answer = (url, what) => html(url, what === "shell" ? SHELL : article(what.word));

const URL_A = "https://app.example/post";

/**
 * A fetcher and an indexer on one index, with a clock the test moves. The
 * fake fetch answers `h.site`; the renderer answers `h.rendered`'s, or, with
 * `browser: false`, reports no browser.
 */
function harness({ browser }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-shell-refresh-"));
  dirs.push(dir);
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const list = [{ folder: "Bar", node: { type: "url", name: "A post", url: URL_A, guid: "g-a" } }];
  const h = {
    clock: Date.UTC(2026, 0, 1),
    site: { word: "aardvark" },
    rendered: { word: "aardvark" },
    /** How long a render takes: longer than the indexer's debounce lets it run on the shell first. */
    renderMs: 1,
    calls: [],
    renders: [],
    embedder: new CountingEmbedder(),
  };
  const now = () => h.clock;
  const renderer = {
    launch: async () =>
      browser ? { ok: true } : { ok: false, reason: "no Chromium-based browser found", hint: "set MNEMOS_BROWSER" },
    render: async (url) => {
      h.renders.push(url);
      await sleep(h.renderMs);
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
      h.calls.push(url);
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
    h.fetcher.stop();
    h.indexer.close();
  };
  return h;
}

/** The first fetch (an article, ok and embedded), then the 30-day refresh, which gets a shell. */
async function okThenShell(h) {
  h.indexer.start();
  await h.indexer.idle();
  h.fetcher.start();
  await h.settle(() => h.page()?.status === "ok" && h.chunks().length > 0 && h.chunks().every((c) => c.vector !== null), "the first fetch");
  const first = { page: h.page(), chunks: h.chunks() };
    h.site = "shell";
  h.clock = first.page.next_attempt_at;
  h.embedder.texts = [];
  return first;
}

test("shell refresh, no browser: the page keeps its chunks and is fetched plainly again on the backoff until it is ok", async () => {
  const h = harness({ browser: false });
  try {
    const first = await okThenShell(h);
    await h.settle(() => h.page().fetched_at === h.clock && h.fetcher.browserNote(), "the shell refresh");
    let page = h.page();
    assert.equal(page.status, "needs_browser");
    assert.equal(page.content_hash, first.page.content_hash, "the text it had stays");
    assert.equal(page.text, first.page.text);
    assert.deepEqual(h.chunks(), first.chunks, "chunks and vectors kept as they were");
    assert.deepEqual(h.embedder.texts, [], "nothing embedded again");
    assert.equal(page.next_attempt_at, null, "no next attempt stored: a later run with a browser renders it at once");
    assert.equal(h.fetcher.browserNote(), "1 page needs a browser; set MNEMOS_BROWSER");

    // Fetched plainly again on a failed page's backoff: 1 h after the shell, then 1 h, 6 h.
    const waits = [backoffMs(0), backoffMs(1), backoffMs(2)];
    assert.deepEqual(waits, [HOUR, HOUR, 6 * HOUR]);
    for (const [i, wait] of waits.entries()) {
      const at = h.page().fetched_at + wait;
      h.clock = at - 60_000;
      assert.deepEqual(await h.quiet(), [], `a minute before plain fetch ${i + 1}`);
      h.clock = at;
      await h.settle(() => h.page().fetched_at === at, `plain fetch ${i + 1}`);
      page = h.page();
      assert.equal(page.status, "needs_browser");
      assert.equal(page.fail_count, i + 1);
      assert.deepEqual(h.chunks(), first.chunks, `chunks kept after plain fetch ${i + 1}`);
    }

    // The site serves its text again: ok, with the new text's chunks, and the count starts over.
    h.site = { word: "bandicoot" };
    h.clock = h.page().fetched_at + backoffMs(3);
    await h.settle(
      () => h.page().status === "ok" && h.chunks().length > 0 && h.chunks().every((c) => /bandicoot/.test(c.text) && c.vector !== null),
      "the recovery",
    );
    page = h.page();
    assert.equal(page.fail_count, 0);
    assert.equal(page.next_attempt_at, h.clock + REFRESH_MS);
    assert.equal(h.fetcher.browserNote(), undefined);
    assert.deepEqual(h.renders, [], "never rendered");
  } finally {
    h.close();
  }
});

test("shell refresh, a browser rendering the same text: the chunks are not cut or embedded again", async () => {
  const h = harness({ browser: true });
  try {
    h.renderMs = 300;
    const first = await okThenShell(h);
    await h.settle(() => h.renders.length === 1 && h.page().status === "ok", "the render");
    assert.equal(h.page().content_hash, first.page.content_hash);
    assert.deepEqual(h.chunks(), first.chunks, "chunks and vectors kept as they were");
    assert.deepEqual(h.embedder.texts, [], "nothing embedded again");
  } finally {
    h.close();
  }
});

test("shell refresh, a browser rendering other text: the chunks are replaced", async () => {
  const h = harness({ browser: true });
  try {
    await okThenShell(h);
    h.rendered = { word: "quokka" };
    await h.settle(
      () => h.renders.length === 1 && h.chunks().length > 0 && h.chunks().every((c) => /quokka/.test(c.text) && c.vector !== null),
      "the rendered text's chunks",
    );
    assert.equal(h.page().status, "ok");
    assert.ok(h.embedder.texts.length > 0 && h.embedder.texts.every((t) => !/aardvark/.test(t)));
  } finally {
    h.close();
  }
});

test("shell refresh, a browser that finds no text either: the browser's last word drops the chunks", async () => {
  const h = harness({ browser: true });
  try {
    await okThenShell(h);
    h.rendered = "shell";
    await h.settle(() => h.renders.length === 1 && h.page().status === "no_content" && h.chunks().length === 0, "the chunks to go");
    assert.equal(h.page().text, null);
    assert.equal(h.page().content_hash, null);
  } finally {
    h.close();
  }
});

/** An index with one bookmark of `url`, for the store's own checks. */
function store(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-shell-refresh-store-"));
  dirs.push(dir);
  const s = IndexStore.open({ bookmarksFile: path.join(dir, "Bookmarks"), dir });
  s.upsertBookmarks([{ guid: "g", url, title: "T", folder_path: "Bar", text_hash: "t" }]);
  return s;
}

test("store: a needs_browser page with the text it had is chunked like an ok one; one without it has lost its chunks", () => {
  const s = store(URL_A);
  try {
    s.upsertPage({ url: URL_A, status: "ok", content_hash: "h1", text: "one" });
    s.replaceChunks(URL_A, ["one"], "h1");
    s.upsertPage({ url: URL_A, status: "needs_browser", content_hash: "h1" });
    assert.deepEqual(s.pagesToChunk(), [], "kept text, chunks cut from it: nothing to do");
    assert.equal(s.getPage(URL_A).text, "one");
    // Kept text the chunks were not cut from (it changed just before the shell) is cut.
    s.upsertPage({ url: URL_A, status: "needs_browser", content_hash: "h2", text: "two" });
    assert.deepEqual(s.pagesToChunk(), [{ url: URL_A, content_hash: "h2" }]);
    s.replaceChunks(URL_A, ["two"], "h2");
    // No text (a page that was never ok): its chunks go.
    s.upsertPage({ url: URL_A, status: "needs_browser", text: null });
    assert.deepEqual(s.pagesToChunk(), [{ url: URL_A, content_hash: null }]);
  } finally {
    s.close();
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

test("keptText: an ok page's text, or one kept already; none from a page without text", () => {
  assert.deepEqual(keptText(row({ status: "ok", content_hash: "h", text: "t" })), { content_hash: "h", text: "t" });
  assert.deepEqual(keptText(row({ status: "needs_browser", content_hash: "h", text: "t" })), { content_hash: "h", text: "t" });
  assert.deepEqual(keptText(row({ status: "needs_browser" })), {});
  assert.deepEqual(keptText(row({ status: "failed", fail_count: 1 })), {});
  assert.deepEqual(keptText(row({ status: "pending" })), {});
});

test("adoptedRow: another index's needs_browser page leaves this one's ok text as it is", () => {
  const NOW = Date.UTC(2026, 0, 1);
  const theirs = row({ status: "needs_browser", fetched_at: NOW - 100, reason: "no readable text" });
  const previous = row({ status: "ok", fetched_at: NOW - SHARED_FRESH_MS * 40, content_hash: "h", text: "the text" });
  const adopted = adoptedRow(theirs, previous, false, NOW);
  assert.equal(adopted.status, "needs_browser");
  assert.equal(adopted.content_hash, "h");
  assert.equal(adopted.text, "the text");
  assert.equal(adoptedRow(theirs, row({ status: "pending" }), false, NOW).content_hash, null);
});
