// One headless browser shared by the fetchers of several bookmarks files
// (dist/headless.js's SharedRenderer): each fetcher gets its own user(), and
// the browser is closed only once none of them has a page left for it, never
// under another fetcher's page; it is launched once for all of them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { FetchPool, Fetcher } from "../dist/fetcher.js";
import { SharedRenderer } from "../dist/headless.js";

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function article(word) {
  const paragraph = (n) =>
    `<p>Paragraph ${n} about the ${word}: a long and careful explanation of how the ${word} lives, ` +
    `what it eats, where it sleeps and why people keep coming back to read more about it.</p>`;
  return `<!doctype html><html><head><title>${word}</title></head><body><article>${[1, 2, 3, 4, 5]
    .map(paragraph)
    .join("")}</article></body></html>`;
}

const SHELL = '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';

const html = (url, body) => ({ status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: body });

/** Chrome's date_added for `n` seconds after a fixed day in 2022. */
const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

function entries(urls) {
  return urls.map((url, i) => ({ folder: "Bookmarks Bar", node: { type: "url", name: url, url, date_added: chromeTime(i) } }));
}

function seededIndex(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-shared-renderer-"));
  dirs.push(dir);
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

/** A plain fetch: a JS shell for URLs with "shell" in them, else an article. */
async function plainFetch(url) {
  await sleep(5);
  return html(url, url.includes("shell") ? SHELL : article("numbat"));
}

/**
 * A renderer that answers after `delayMs(url)`, counting launches and closes,
 * and noting a close that came while a page was still in the browser.
 */
function fakeRenderer(delayMs = () => 20) {
  const renderer = {
    launches: 0,
    closes: 0,
    running: false,
    inBrowser: 0,
    closedUnderPage: false,
    rendered: [],
    async launch() {
      if (!renderer.running) renderer.launches++;
      renderer.running = true;
      return { ok: true };
    },
    async render(url) {
      assert.ok(renderer.running, "render after launch");
      renderer.inBrowser++;
      await sleep(delayMs(url));
      renderer.inBrowser--;
      renderer.rendered.push(url);
      return html(url, article(`rendered ${new URL(url).hostname}`));
    },
    async close() {
      if (renderer.inBrowser > 0) renderer.closedUnderPage = true;
      if (renderer.running) renderer.closes++;
      renderer.running = false;
    },
  };
  return renderer;
}

test("SharedRenderer: the browser closes only when its last user closes it", async () => {
  const fake = fakeRenderer();
  const shared = new SharedRenderer(fake);
  const a = shared.user();
  const b = shared.user();
  const idle = shared.user();

  assert.deepEqual(await a.launch(), { ok: true });
  assert.deepEqual(await b.launch(), { ok: true });
  assert.equal(fake.launches, 1, "one browser for both");
  assert.equal(shared.users, 2);

  await idle.close(); // never launched it: not its browser to close
  await a.close();
  assert.equal(fake.closes, 0, "still open for b");
  await a.close(); // a second close counts a out no further
  assert.equal(fake.closes, 0);
  assert.equal((await b.render("https://x.example/", { config: {} })).status, "ok");

  await b.close();
  assert.equal(fake.closes, 1, "closed with its last user");
  assert.equal(shared.users, 0);

  // launched again by whichever user needs it next
  await a.launch();
  assert.equal(fake.launches, 2);
  await a.close();
  assert.equal(fake.closes, 2);
});

test("SharedRenderer: a user that renders without launching counts too", async () => {
  const fake = fakeRenderer();
  const shared = new SharedRenderer(fake);
  const a = shared.user();
  const b = shared.user();
  await a.launch();
  await b.render("https://x.example/", { config: {} });
  await a.close();
  assert.equal(fake.closes, 0, "b still has it");
  await b.close();
  assert.equal(fake.closes, 1);
});

test("Fetchers of two sources share one browser, closed once neither has a page for it", async () => {
  const quick = entries(["https://quick.example/shell", "https://quick.example/article"]);
  const slow = entries(["https://slow.example/shell", "https://slow.example/article"]);
  const indexes = [seededIndex(quick), seededIndex(slow)];
  // The slow source's page is still in the browser when the quick one's fetcher has none left.
  const fake = fakeRenderer((url) => (url.includes("slow") ? 400 : 20));
  const shared = new SharedRenderer(fake);
  const pool = new FetchPool({ domainGapMs: 10 });
  const fetchers = [quick, slow].map(
    (list, i) =>
      new Fetcher({
        env: {},
        bookmarksFile: () => indexes[i].bookmarksFile,
        entries: () => list,
        dir: indexes[i].dir,
        fetch: plainFetch,
        pool,
        renderer: shared.user(),
        heartbeatMs: 60_000,
      }),
  );
  try {
    for (const fetcher of fetchers) fetcher.start();
    await until(
      () => fetchers.every((fetcher) => fetcher.status().state === "idle") && fake.rendered.length === 2,
      "both fetchers to go idle",
    );
    assert.equal(fake.launches, 1, "one browser for both sources");
    assert.equal(fake.closes, 1, "closed once, when neither had a page left for it");
    assert.equal(fake.closedUnderPage, false, "never closed under a page");
    assert.equal(fake.running, false);
  } finally {
    for (const fetcher of fetchers) fetcher.stop();
  }
  assert.equal(fake.closes, 1, "stopping closes nothing more");
  for (const [i, url] of ["https://quick.example/shell", "https://slow.example/shell"].entries()) {
    const page = pagesOf(indexes[i]).get(url);
    assert.equal(page.status, "ok", `${url}: ${page.reason}`);
    assert.match(page.text, /Paragraph 1 about the rendered/);
  }
});
