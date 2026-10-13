// Bookmarked PDFs in the background fetcher (dist/fetcher.js): pdfExtraction
// maps pdf.ts's results to page states, and pageResult stores them. In
// process, a Fetcher with a fake fetch serving PDFs built by
// fixtures/make-pdf.js: a PDF's text is stored like a page's, one with no text
// is no_content and never goes to the browser, an encrypted one is skipped,
// broken bytes fail with backoff, and with no PDF parser PDFs are not asked
// for. Over MCP (the built server, MNEMOS_EMBEDDER=fake, a fixture site on
// 127.0.0.1): a PDF bookmark reaches ok, and a query with words only in the
// PDF finds it, matched_on "page".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IndexStore, indexFile } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { BACKOFF_BASE_MS, Fetcher, REFRESH_MS, contentHash, pageResult, pdfExtraction } from "../dist/fetcher.js";
import { makePdf } from "./fixtures/make-pdf.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-pdf-pages-"));
  dirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Words found only in the PDF: no title, URL or folder of the fixtures has them. */
const PAPER_LINES = [
  ["Quokka burrows and wombat tunnels compared.", "The quokka burrow is shallow; the wombat tunnel is deep."],
  ["A second page on quokka burrows and wombat tunnels, at some length."],
];
const PAPER_TEXT =
  "Quokka burrows and wombat tunnels compared. The quokka burrow is shallow; the wombat tunnel is deep.\n\n" +
  "A second page on quokka burrows and wombat tunnels, at some length.";

// --- pure mapping ----------------------------------------------------------------

test("pdfExtraction: text, a scan, encrypted, broken, no parser, aborted", () => {
  const ok = { status: "ok", text: "Some text.", pages: 1, pagesRead: 1, truncated: false };
  assert.deepEqual(pdfExtraction(ok), { status: "ok", text: "Some text." });
  assert.deepEqual(pdfExtraction({ ...ok, text: "" }), { status: "no_content", reason: "no text in the PDF" });
  assert.deepEqual(pdfExtraction({ status: "failed", reason: "encrypted" }), { status: "skipped", reason: "encrypted" });
  assert.deepEqual(pdfExtraction({ status: "unavailable", reason: "no unpdf" }), { status: "skipped", reason: "pdf-unavailable" });
  assert.deepEqual(pdfExtraction({ status: "failed", reason: "invalid", detail: "bad header" }), {
    status: "failed",
    reason: "pdf invalid: bad header",
  });
  assert.deepEqual(pdfExtraction({ status: "failed", reason: "error" }), { status: "failed", reason: "pdf error" });
  assert.equal(pdfExtraction({ status: "failed", reason: "aborted" }), undefined);
});

test("pageResult: a PDF's text is ok with its hash; skipped waits a refresh; failed backs off", () => {
  const url = "https://a.example/paper.pdf";
  const outcome = { status: "ok", kind: "pdf", url, httpStatus: 200, contentType: "application/pdf", pdf: new Uint8Array() };
  const now = 1_000_000;
  const ok = pageResult(url, outcome, { status: "ok", text: PAPER_TEXT }, 2, now);
  assert.equal(ok.status, "ok");
  assert.equal(ok.text, PAPER_TEXT);
  assert.equal(ok.content_hash, contentHash(PAPER_TEXT));
  assert.equal(ok.fail_count, 0);
  const skipped = pageResult(url, outcome, { status: "skipped", reason: "encrypted" }, 2, now);
  assert.deepEqual(
    { status: skipped.status, reason: skipped.reason, next: skipped.next_attempt_at, fails: skipped.fail_count, text: skipped.text },
    { status: "skipped", reason: "encrypted", next: now + REFRESH_MS, fails: 0, text: null },
  );
  const failed = pageResult(url, outcome, { status: "failed", reason: "pdf invalid" }, 0, now);
  assert.equal(failed.status, "failed");
  assert.equal(failed.fail_count, 1);
  assert.equal(failed.next_attempt_at, now + BACKOFF_BASE_MS);
});

// --- the fetcher, in process -----------------------------------------------------

/** Chrome's date_added for `n` seconds after a fixed day in 2022. */
const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

function entries(urls) {
  return urls.map((url, i) => ({ folder: "Bookmarks Bar", node: { type: "url", name: url, url, date_added: chromeTime(i) } }));
}

function seededIndex(list) {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(bookmarkRows(list));
  store.close();
  return { dir, bookmarksFile };
}

function pagesOf(index) {
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    return new Map(store.pageStates().map((p) => [p.url, store.getPage(p.url)]));
  } finally {
    store.close();
  }
}

/** A fake fetch serving `files[url]` as a PDF, recording each call's acceptPdf. */
function pdfFetch(files) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, acceptPdf: options.acceptPdf });
    await sleep(5);
    if (options.acceptPdf === false) return { status: "skipped", reason: "not-html", url };
    return { status: "ok", kind: "pdf", url, httpStatus: 200, contentType: "application/pdf", pdf: files[url] };
  };
  return { fn, calls };
}

/** A renderer that must never be used. */
function noRenderer() {
  const renderer = {
    launches: 0,
    async launch() {
      renderer.launches++;
      return { ok: false, reason: "test", hint: "test" };
    },
    async render(url) {
      return { status: "failed", reason: "connection", url, detail: "no browser in this test" };
    },
    async close() {},
  };
  return renderer;
}

function fetcherFor(index, list, fetch, options = {}) {
  return new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => list,
    dir: index.dir,
    fetch: fetch.fn,
    domainGapMs: 10,
    heartbeatMs: 60_000,
    ...options,
  });
}

test("Fetcher: a PDF's text is stored; a scan is no_content without the browser; encrypted skipped; broken failed", async () => {
  const urls = {
    paper: "https://a.example/paper.pdf",
    scan: "https://b.example/scan.pdf",
    locked: "https://c.example/locked.pdf",
    broken: "https://d.example/broken.pdf",
  };
  const files = {
    [urls.paper]: makePdf(PAPER_LINES),
    [urls.scan]: makePdf([[]]),
    [urls.locked]: makePdf([["secret"]], { encrypt: true }),
    [urls.broken]: new TextEncoder().encode("%PDF-1.4 and then nothing a PDF has"),
  };
  const list = entries(Object.values(urls));
  const index = seededIndex(list);
  const fetch = pdfFetch(files);
  const renderer = noRenderer();
  const fetcher = fetcherFor(index, list, fetch, { renderer });
  try {
    fetcher.start();
    await until(() => fetch.calls.length === list.length && fetcher.status().state === "idle", "every PDF");
  } finally {
    fetcher.stop();
  }
  assert.ok(fetch.calls.every((c) => c.acceptPdf === true), "PDFs are asked for when unpdf loads");
  assert.equal(renderer.launches, 0, "no PDF goes to the browser");
  const pages = pagesOf(index);
  const paper = pages.get(urls.paper);
  assert.equal(paper.status, "ok");
  assert.equal(paper.text, PAPER_TEXT);
  assert.equal(paper.content_hash, contentHash(PAPER_TEXT));
  const scan = pages.get(urls.scan);
  assert.equal(scan.status, "no_content");
  assert.equal(scan.next_attempt_at, null);
  const locked = pages.get(urls.locked);
  assert.equal(locked.status, "skipped");
  assert.equal(locked.reason, "encrypted");
  const broken = pages.get(urls.broken);
  assert.equal(broken.status, "failed");
  assert.equal(broken.fail_count, 1);
  assert.match(broken.reason, /^pdf (invalid|error)/);
});

test("Fetcher: with no PDF parser, PDFs are not asked for, and the parser is checked once", async () => {
  const list = entries(["https://a.example/1.pdf", "https://b.example/2.pdf"]);
  const index = seededIndex(list);
  const fetch = pdfFetch({});
  let loads = 0;
  const fetcher = fetcherFor(index, list, fetch, {
    renderer: noRenderer(),
    pdfLoad: async () => {
      loads++;
      throw new Error("Cannot find package 'unpdf'");
    },
  });
  try {
    fetcher.start();
    await until(() => fetch.calls.length === list.length && fetcher.status().state === "idle", "both pages");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(fetch.calls.map((c) => c.acceptPdf), [false, false]);
  assert.equal(loads, 1);
  for (const page of pagesOf(index).values()) {
    assert.equal(page.status, "skipped");
    assert.equal(page.reason, "not-html");
  }
});

// --- over MCP --------------------------------------------------------------------

/** A node:http server on 127.0.0.1 serving `files` (path to [type, body]). */
async function fixtureSite(files) {
  const server = http.createServer((req, res) => {
    const file = files[new URL(req.url, "http://x").pathname];
    if (!file) return res.writeHead(404).end("no such page");
    res.writeHead(200, { "Content-Type": file[0] }).end(file[1]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    host,
    url: (p) => `http://${host}${p}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function article(title, word) {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>The ${word} orchard, visit ${i}: the ${word} orchard keeps its keeper busy all year.</p>`);
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paragraphs.join("")}</article></body></html>`;
}

test("e2e: a PDF bookmark reaches ok, and words only in the PDF find it, matched_on page", async () => {
  const site = await fixtureSite({
    "/paper": ["application/pdf", Buffer.from(makePdf(PAPER_LINES))],
    "/scan": ["application/pdf", Buffer.from(makePdf([[]]))],
    "/coast": ["text/html; charset=utf-8", article("Coast notes", "lighthouse")],
  });
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const bookmarks = path.join(dir, "Bookmarks");
  const children = [
    { type: "url", name: "Seaside reading", url: site.url("/coast"), date_added: chromeTime(0) },
    { type: "url", name: "Scanned leaflet", url: site.url("/scan"), date_added: chromeTime(1) },
    { type: "url", name: "Field study", url: site.url("/paper"), date_added: chromeTime(2) },
  ];
  const folder = (name, kids = []) => ({ type: "folder", name, children: kids });
  fs.writeFileSync(
    bookmarks,
    JSON.stringify({ checksum: "x", version: 1, roots: { bookmark_bar: folder("Bookmarks bar", children), other: folder("Other bookmarks"), synced: folder("Mobile bookmarks") } }),
  );
  const client = new Client({ name: "mnemos-pdf-pages", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: bookmarks,
        MNEMOS_CACHE_DIR: cache,
        MNEMOS_EMBEDDER: "fake",
        MNEMOS_FETCH_ALLOW_HOSTS: site.host,
        MNEMOS_FETCH_PAGES: "",
        MNEMOS_BROWSER: "0",
      },
      stderr: "ignore",
    }),
  );
  try {
    const data = await until(async () => {
      const result = await client.callTool({ name: "semantic_search", arguments: { query: "quokka burrows wombat tunnels" } });
      assert.ok(!result.isError, result.content[0].text);
      const d = JSON.parse(result.content[0].text);
      return d.results.some((r) => r.matched_on === "page" && r.url === site.url("/paper")) ? d : null;
    }, "the PDF's chunks to be embedded");
    const hit = data.results[0];
    assert.equal(hit.title, "Field study");
    assert.equal(hit.url, site.url("/paper"));
    assert.equal(hit.matched_on, "page");
    assert.match(hit.snippet, /quokka burrow/i);

    const rows = await until(() => {
      const db = new DatabaseSync(indexFile(bookmarks, cache));
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const all = new Map(db.prepare("SELECT url, status, text FROM pages").all().map((r) => [r.url, r]));
        const scan = all.get(site.url("/scan"))?.status;
        return scan && scan !== "pending" ? all : null;
      } finally {
        db.close();
      }
    }, "the scan to be fetched");
    assert.equal(rows.get(site.url("/paper")).status, "ok");
    assert.equal(rows.get(site.url("/paper")).text, PAPER_TEXT);
    // A scan has no text, and no browser would find any: no_content, not needs_browser.
    assert.equal(rows.get(site.url("/scan")).status, "no_content");
  } finally {
    await client.close();
    await site.close();
  }
});
