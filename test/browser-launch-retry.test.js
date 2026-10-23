// A browser that did not start is tried again (dist/headless.js's
// HeadlessBrowser with a fake playwright-core, and dist/fetcher.js with it):
// the failure is kept until a doubling backoff has passed, and needs_browser
// pages are rendered once a later launch succeeds. No browser found,
// MNEMOS_BROWSER=0, MNEMOS_BROWSER naming no file and a missing
// playwright-core are kept for the process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher } from "../dist/fetcher.js";
import { HeadlessBrowser, LAUNCH_RETRY_MIN_MS, LAUNCH_RETRY_MAX_MS } from "../dist/headless.js";

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-launch-retry-"));
  dirs.push(dir);
  return dir;
}

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

/** A page in the fake browser: shows `url` with a rendered article. */
function fakePage() {
  let at = "about:blank";
  return {
    on() {},
    async goto(url) {
      at = url;
      return null;
    },
    async waitForLoadState() {},
    async content() {
      return article(`rendered ${new URL(at).hostname}`);
    },
    url: () => at,
    async close() {},
  };
}

/** A playwright-core whose first `failures` launches throw, and later ones start a browser that renders articles. */
function fakePlaywright(failures) {
  const playwright = {
    launches: 0,
    chromium: {
      async launchPersistentContext() {
        playwright.launches++;
        if (playwright.launches <= failures) throw new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded.\nCall log: …");
        return {
          async route() {},
          async newPage() {
            return fakePage();
          },
          async newCDPSession() {
            return {
              async send(method) {
                return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "top" } } } : {};
              },
              on() {},
            };
          },
          async close() {},
        };
      },
    },
  };
  return playwright;
}

const FOUND = { ok: true, executablePath: "/Applications/Some Chrome", source: "chrome" };

test("HeadlessBrowser: a browser that did not start is tried again after a doubling backoff", async () => {
  let clock = 1_000_000;
  const playwright = fakePlaywright(2);
  const browser = new HeadlessBrowser({
    env: {},
    resolve: () => FOUND,
    importPlaywright: async () => playwright,
    tmpDir: tempDir(),
    now: () => clock,
  });
  try {
    const first = await browser.launch();
    assert.equal(first.ok, false);
    assert.equal(first.reason, "/Applications/Some Chrome did not start: browserType.launchPersistentContext: Timeout 180000ms exceeded.");
    assert.equal(first.hint, first.reason);
    assert.equal(first.retry_at, clock + LAUNCH_RETRY_MIN_MS);

    // Before the backoff is over: the same answer, no launch.
    clock += LAUNCH_RETRY_MIN_MS - 1;
    assert.deepEqual(await browser.launch(), first);
    assert.equal(playwright.launches, 1);

    // After it: tried again; failing again doubles the wait.
    clock += 1;
    const second = await browser.launch();
    assert.equal(second.ok, false);
    assert.equal(second.retry_at, clock + 2 * LAUNCH_RETRY_MIN_MS);
    assert.equal(playwright.launches, 2);

    clock = second.retry_at;
    assert.deepEqual(await browser.launch(), { ok: true });
    assert.equal(playwright.launches, 3);
    const outcome = await browser.render("https://a.example/shell", { config: { skipDomains: [], skipFolders: [], allowHosts: [] } });
    assert.equal(outcome.status, "ok");
    assert.match(outcome.html, /Paragraph 1 about the rendered a\.example/);
  } finally {
    await browser.close();
  }
});

test("HeadlessBrowser: the backoff stops doubling at LAUNCH_RETRY_MAX_MS, and starts over once a launch succeeds", async () => {
  let clock = 0;
  const playwright = fakePlaywright(Infinity);
  const browser = new HeadlessBrowser({ env: {}, resolve: () => FOUND, importPlaywright: async () => playwright, tmpDir: tempDir(), now: () => clock });
  let waits = [];
  for (let i = 0; i < 10; i++) {
    const result = await browser.launch();
    waits.push(result.retry_at - clock);
    clock = result.retry_at;
  }
  assert.deepEqual(waits.slice(0, 3), [LAUNCH_RETRY_MIN_MS, 2 * LAUNCH_RETRY_MIN_MS, 4 * LAUNCH_RETRY_MIN_MS]);
  assert.equal(Math.max(...waits), LAUNCH_RETRY_MAX_MS);
  assert.equal(waits.at(-1), LAUNCH_RETRY_MAX_MS);
  await browser.close();

  // A start that succeeds resets the backoff: the next failure waits the shortest time again.
  let fail = false;
  const flaky = {
    chromium: {
      async launchPersistentContext(dir, options) {
        if (fail) throw new Error("did not answer");
        return fakePlaywright(0).chromium.launchPersistentContext(dir, options);
      },
    },
  };
  const again = new HeadlessBrowser({ env: {}, resolve: () => FOUND, importPlaywright: async () => flaky, tmpDir: tempDir(), now: () => clock });
  fail = true;
  clock = (await again.launch()).retry_at;
  clock = (await again.launch()).retry_at;
  fail = false;
  assert.deepEqual(await again.launch(), { ok: true });
  await again.close();
  fail = true;
  const result = await again.launch();
  assert.equal(result.retry_at - clock, LAUNCH_RETRY_MIN_MS);
  await again.close();
});

test("HeadlessBrowser: no browser, MNEMOS_BROWSER=0 or naming no file, and no playwright-core are kept for the process", async () => {
  let clock = 0;
  const cases = [
    { name: "none", resolve: () => ({ ok: false, why: "none", reason: "no Chromium-based browser found" }) },
    { name: "off", env: { MNEMOS_BROWSER: "0" } },
    { name: "missing", env: { MNEMOS_BROWSER: path.join(os.tmpdir(), "no-such-browser") } },
    { name: "playwright-core", resolve: () => FOUND, importPlaywright: () => Promise.reject(new Error("Cannot find package 'playwright-core'")) },
  ];
  for (const { name, env = {}, resolve, importPlaywright } of cases) {
    let resolves = 0;
    let imports = 0;
    const browser = new HeadlessBrowser({
      env,
      ...(resolve && {
        resolve: () => {
          resolves++;
          return resolve();
        },
      }),
      importPlaywright: () => {
        imports++;
        return importPlaywright ? importPlaywright() : assert.fail(`${name}: no browser, no import`);
      },
      tmpDir: tempDir(),
      now: () => clock,
    });
    const first = await browser.launch();
    assert.equal(first.ok, false, name);
    assert.equal(first.retry_at, undefined, `${name}: never tried again`);
    clock += 10 * LAUNCH_RETRY_MAX_MS;
    assert.deepEqual(await browser.launch(), first, name);
    assert.ok(resolves <= 1, `${name}: looked for once`);
    assert.ok(imports <= 1, `${name}: imported once`);
    await browser.close();
  }
});

/** Chrome's date_added for `n` seconds after a fixed day in 2022. */
const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

test("Fetcher: needs_browser pages are rendered once a browser that did not start is tried again", async () => {
  const urls = ["https://a.example/shell", "https://b.example/shell"];
  const list = urls.map((url, i) => ({ folder: "Bookmarks Bar", node: { type: "url", name: url, url, date_added: chromeTime(i) } }));
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const seed = IndexStore.open({ bookmarksFile, dir });
  seed.syncBookmarks(bookmarkRows(list));
  seed.close();
  const pages = () => {
    const store = IndexStore.open({ bookmarksFile, dir });
    try {
      return new Map(store.pageStates().map((p) => [p.url, store.getPage(p.url)]));
    } finally {
      store.close();
    }
  };

  // Real time, moved on by the test past the backoff.
  let offset = 0;
  const now = () => Date.now() + offset;
  const playwright = fakePlaywright(1);
  const renderer = new HeadlessBrowser({ env: {}, resolve: () => FOUND, importPlaywright: async () => playwright, tmpDir: tempDir(), now });
  const plain = [];
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => bookmarksFile,
    entries: () => list,
    dir,
    fetch: async (url) => {
      plain.push(url);
      return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: SHELL };
    },
    renderer,
    domainGapMs: 10,
    heartbeatMs: 60_000,
    idlePollMs: 50,
    now,
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && fetcher.browserNote(), "the note");
    assert.match(fetcher.browserNote(), /^2 pages need a browser; \/Applications\/Some Chrome did not start: /);
    assert.equal(playwright.launches, 1);
    for (const page of pages().values()) assert.equal(page.status, "needs_browser");

    // Idle polls before the backoff is over launch nothing.
    await sleep(200);
    assert.equal(playwright.launches, 1);

    offset += LAUNCH_RETRY_MIN_MS;
    await until(() => [...pages().values()].every((page) => page.status === "ok"), "the pages to be rendered");
    assert.equal(playwright.launches, 2);
    for (const url of urls) assert.match(pages().get(url).text, new RegExp(`rendered ${new URL(url).hostname}`));
    await until(() => fetcher.status().state === "idle", "the fetcher to go idle");
    assert.equal(fetcher.browserNote(), undefined);
  } finally {
    fetcher.stop();
    console.error = original;
  }
  assert.deepEqual([...plain].sort(), urls, "each page fetched plainly once");
  assert.equal(errors.filter((e) => /did not start/.test(e)).length, 1, "logged once, on stderr");
});
