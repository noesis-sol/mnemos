// The page fetcher's headless browser step (dist/fetcher.js with a fake
// renderer, and dist/headless.js's HeadlessBrowser with playwright-core or a
// browser missing): a page whose plain fetch has no readable text is
// needs_browser, then rendered and stored with the rendered text; the
// browser is launched only when such a page comes, holds at most two pages
// at once and is closed once none is left; a rendering that fails backs off,
// one with no text either is no_content; pages left needs_browser by an
// earlier run are rendered by the next. With playwright-core absent or no
// browser found, those pages stay needs_browser, nothing crashes, and
// browserNote says how many and what to do.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher, BACKOFF_BASE_MS } from "../dist/fetcher.js";
import { HeadlessBrowser } from "../dist/headless.js";

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
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

/** Chrome's date_added for `n` seconds after a fixed day in 2022. */
const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

function entries(urls) {
  return urls.map((url, i) => ({ folder: "Bookmarks Bar", node: { type: "url", name: url, url, date_added: chromeTime(i) } }));
}

function seededIndex(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-headless-fetcher-"));
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

/** A plain fetch: a JS shell for URLs with "shell" in them, served from `/final` after a redirect; else an article. */
function plainFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    await sleep(5);
    if (url.includes("shell")) {
      const final = `${url}/final`;
      return { status: "ok", kind: "html", url: final, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: SHELL };
    }
    return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: article("numbat") };
  };
  return { fn, calls };
}

/** A renderer that answers `answer(url)` after `delayMs`, counting launches, closes and pages at once. */
function fakeRenderer({ delayMs = 40, answer } = {}) {
  const renderer = {
    launches: 0,
    closes: 0,
    running: false,
    rendered: [],
    inBrowser: 0,
    maxInBrowser: 0,
    async launch() {
      if (!renderer.running) renderer.launches++;
      renderer.running = true;
      return { ok: true };
    },
    async render(url, { signal }) {
      assert.ok(renderer.running, "render after launch");
      renderer.rendered.push(url);
      renderer.inBrowser++;
      renderer.maxInBrowser = Math.max(renderer.maxInBrowser, renderer.inBrowser);
      await sleep(delayMs);
      renderer.inBrowser--;
      if (signal?.aborted) return { status: "failed", reason: "aborted", url };
      return (
        answer?.(url) ?? {
          status: "ok",
          kind: "html",
          url,
          httpStatus: 200,
          contentType: "text/html",
          charset: "utf-8",
          html: article(`rendered ${new URL(url).hostname}`),
        }
      );
    },
    async close() {
      if (renderer.running) renderer.closes++;
      renderer.running = false;
    },
  };
  return renderer;
}

function fetcherFor(index, list, fetch, renderer, options = {}) {
  return new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => list,
    dir: index.dir,
    fetch: fetch.fn,
    renderer,
    domainGapMs: 10,
    heartbeatMs: 60_000,
    ...options,
  });
}

async function runToIdle(fetcher, done = () => true) {
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && done(), "the fetcher to go idle");
  } finally {
    fetcher.stop();
  }
}

test("Fetcher: JS shells are rendered in the browser, two at a time, which closes once none is left", async () => {
  const shells = ["a", "b", "c", "d", "e"].map((host) => `https://${host}.example/shell`);
  const list = entries(["https://f.example/article", ...shells]);
  const index = seededIndex(list);
  const fetch = plainFetch();
  const renderer = fakeRenderer();
  const fetcher = fetcherFor(index, list, fetch, renderer);
  await runToIdle(fetcher, () => renderer.rendered.length === shells.length);

  assert.equal(renderer.launches, 1, "one browser for the run");
  assert.equal(renderer.closes, 1, "closed once no page needed it");
  assert.equal(renderer.maxInBrowser, 2, "at most two pages in the browser at once");
  // Rendered from where the plain fetch ended up.
  assert.deepEqual([...renderer.rendered].sort(), shells.map((url) => `${url}/final`).sort());
  assert.deepEqual([...fetch.calls].sort(), [...list.map((e) => e.node.url)].sort(), "each page fetched plainly once");
  const pages = pagesOf(index);
  for (const url of shells) {
    const page = pages.get(url);
    assert.equal(page.status, "ok", `${url}: ${page.reason}`);
    assert.match(page.text, new RegExp(`Paragraph 1 about the rendered ${new URL(url).hostname}`));
    assert.equal(page.final_url, `${url}/final`);
  }
  assert.equal(pages.get("https://f.example/article").status, "ok");
  assert.equal(fetcher.browserNote(), undefined);
});

test("Fetcher: no page without text, no browser launched", async () => {
  const list = entries(["https://a.example/1", "https://b.example/2"]);
  const index = seededIndex(list);
  const renderer = fakeRenderer();
  await runToIdle(fetcherFor(index, list, plainFetch(), renderer));
  assert.equal(renderer.launches, 0);
  for (const page of pagesOf(index).values()) assert.equal(page.status, "ok");
});

test("Fetcher: a rendering that fails backs off; one with no text either is no_content", async () => {
  const list = entries(["https://a.example/shell", "https://b.example/shell"]);
  const index = seededIndex(list);
  const renderer = fakeRenderer({
    answer: (url) =>
      url.startsWith("https://a.")
        ? { status: "failed", reason: "timeout", url }
        : { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: SHELL },
  });
  await runToIdle(fetcherFor(index, list, plainFetch(), renderer), () => renderer.rendered.length === 2);
  const pages = pagesOf(index);
  const failed = pages.get("https://a.example/shell");
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "timeout");
  assert.equal(failed.fail_count, 1);
  assert.equal(failed.next_attempt_at - failed.fetched_at, BACKOFF_BASE_MS);
  const empty = pages.get("https://b.example/shell");
  assert.equal(empty.status, "no_content");
  assert.equal(empty.next_attempt_at, null);
});

test("Fetcher: playwright-core absent: pages stay needs_browser, the note says so, nothing crashes", async () => {
  const list = entries(["https://a.example/shell", "https://b.example/shell", "https://c.example/article"]);
  const index = seededIndex(list);
  let imports = 0;
  const renderer = new HeadlessBrowser({
    env: {},
    resolve: () => ({ ok: true, executablePath: "/Applications/Some Chrome", source: "chrome" }),
    importPlaywright: () => {
      imports++;
      return Promise.reject(new Error("Cannot find package 'playwright-core' imported from dist/headless.js"));
    },
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  const fetcher = fetcherFor(index, list, plainFetch(), renderer);
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && fetcher.browserNote(), "the note");
    assert.equal(fetcher.browserNote(), "2 pages need a browser; playwright-core is not installed");
    assert.notEqual(fetcher.status().state, "failed");
  } finally {
    fetcher.stop();
    console.error = original;
  }
  assert.equal(imports, 1, "tried once for the run");
  assert.equal(errors.filter((e) => /playwright-core is not installed/.test(e)).length, 1, "logged once, on stderr");
  const pages = pagesOf(index);
  for (const url of ["https://a.example/shell", "https://b.example/shell"]) {
    assert.equal(pages.get(url).status, "needs_browser");
    assert.equal(pages.get(url).text, null);
  }
  assert.equal(pages.get("https://c.example/article").status, "ok");
});

test("Fetcher: no browser found: 'N pages need a browser; set MNEMOS_BROWSER', and a later run renders them", async () => {
  const list = entries(["https://a.example/shell"]);
  const index = seededIndex(list);
  const none = new HeadlessBrowser({
    env: {},
    resolve: () => ({ ok: false, why: "none", reason: "no Chromium-based browser found" }),
    importPlaywright: () => assert.fail("no browser, no import"),
  });
  const original = console.error;
  console.error = () => {};
  let fetcher = fetcherFor(index, list, plainFetch(), none);
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && fetcher.browserNote(), "the note");
    assert.equal(fetcher.browserNote(), "1 page needs a browser; set MNEMOS_BROWSER");
  } finally {
    fetcher.stop();
    console.error = original;
  }
  assert.equal(pagesOf(index).get("https://a.example/shell").status, "needs_browser");

  // The next run has a browser: the page is rendered, not fetched plainly again.
  const fetch = plainFetch();
  const renderer = fakeRenderer();
  fetcher = fetcherFor(index, list, fetch, renderer);
  await runToIdle(fetcher, () => renderer.rendered.length === 1);
  assert.deepEqual(fetch.calls, []);
  assert.deepEqual(renderer.rendered, ["https://a.example/shell/final"]);
  assert.equal(pagesOf(index).get("https://a.example/shell").status, "ok");
  assert.equal(fetcher.browserNote(), undefined);
});

test("HeadlessBrowser: MNEMOS_BROWSER=0 and a MNEMOS_BROWSER naming no file are unavailable, with the reason", async () => {
  const off = new HeadlessBrowser({ env: { MNEMOS_BROWSER: "0" } });
  assert.deepEqual(await off.launch(), {
    ok: false,
    reason: "MNEMOS_BROWSER=0 turns page rendering off",
    hint: "MNEMOS_BROWSER=0 turns page rendering off",
  });
  const missing = new HeadlessBrowser({ env: { MNEMOS_BROWSER: path.join(os.tmpdir(), "no-such-browser") } });
  const result = await missing.launch();
  assert.equal(result.ok, false);
  assert.match(result.hint, /^MNEMOS_BROWSER: no browser at /);
  // A render without a browser fails like a connection would, never throws.
  const outcome = await missing.render("https://a.example/", { config: { skipDomains: [], skipFolders: [], allowHosts: [] } });
  assert.equal(outcome.status, "failed");
  await missing.close();
});
