// needs_browser pages and the 30-day schedule (dist/fetcher.js, dist/index-store.js):
// duePages leaves needs_browser pages out, even with a next attempt due, so a
// page waiting for the browser is queued once, for the browser, never for a
// plain fetch as well; and the browser waits out a next attempt set on one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher, REFRESH_MS } from "../dist/fetcher.js";

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

const page = (url, word) => ({ status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: article(word) });

const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

function entries(urls) {
  return urls.map((url, i) => ({ folder: "Bookmarks Bar", node: { type: "url", name: url, url, date_added: chromeTime(i) } }));
}

const FETCHED_AT = 1_000_000;
const SHELL = "https://a.example/shell";

/** An index whose one bookmark is a needs_browser page with this next attempt. */
function seededIndex(list, nextAttemptAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-needs-browser-due-"));
  dirs.push(dir);
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(bookmarkRows(list));
  store.upsertPage({ url: SHELL, status: "needs_browser", final_url: `${SHELL}/final`, fetched_at: FETCHED_AT, next_attempt_at: nextAttemptAt, text: null });
  store.close();
  return { dir, bookmarksFile };
}

function pageOf(index, url) {
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    return store.getPage(url);
  } finally {
    store.close();
  }
}

function run(index, list, now) {
  const fetched = [];
  const rendered = [];
  const fetcher = new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => list,
    dir: index.dir,
    fetch: async (url) => {
      fetched.push(url);
      await sleep(5);
      return page(url, "numbat");
    },
    renderer: {
      launch: async () => ({ ok: true }),
      render: async (url) => {
        rendered.push(url);
        await sleep(5);
        return page(url, "quokka");
      },
      close: async () => {},
    },
    domainGapMs: 10,
    heartbeatMs: 60_000,
    now: () => now,
  });
  return { fetcher, fetched, rendered };
}

test("store: duePages leaves out needs_browser pages, even with a next attempt due", () => {
  const list = entries([SHELL, "https://b.example/old", "https://c.example/new"]);
  const index = seededIndex(list, FETCHED_AT + REFRESH_MS);
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    store.addPendingPages();
    store.upsertPage({ url: "https://b.example/old", status: "ok", fetched_at: FETCHED_AT, next_attempt_at: FETCHED_AT + REFRESH_MS, text: "old" });
    assert.deepEqual(store.duePages(FETCHED_AT + REFRESH_MS), [
      { url: "https://c.example/new", pending: true },
      { url: "https://b.example/old", pending: false },
    ]);
  } finally {
    store.close();
  }
});

test("Fetcher: a needs_browser page 30 days old is queued once, for the browser, not fetched plainly too", async () => {
  const list = entries([SHELL]);
  const index = seededIndex(list, FETCHED_AT + REFRESH_MS);
  const { fetcher, fetched, rendered } = run(index, list, FETCHED_AT + REFRESH_MS + 1);
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && rendered.length > 0, "the page to be rendered");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(fetched, [], "no plain fetch");
  assert.deepEqual(rendered, [`${SHELL}/final`], "rendered once");
  assert.equal(pageOf(index, SHELL).status, "ok");
});

test("Fetcher: the browser waits out a next attempt set on a needs_browser page", async () => {
  const list = entries([SHELL, "https://b.example/article"]);
  const index = seededIndex(list, FETCHED_AT + REFRESH_MS);

  // Before it: the other page is fetched, the shell left as it is.
  let { fetcher, fetched, rendered } = run(index, list, FETCHED_AT + REFRESH_MS - 1);
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && fetched.length > 0, "the fetcher to go idle");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(fetched, ["https://b.example/article"]);
  assert.deepEqual(rendered, []);
  assert.equal(pageOf(index, SHELL).status, "needs_browser");

  // At it: rendered.
  ({ fetcher, fetched, rendered } = run(index, list, FETCHED_AT + REFRESH_MS));
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && rendered.length > 0, "the page to be rendered");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(fetched, []);
  assert.deepEqual(rendered, [`${SHELL}/final`]);
  assert.equal(pageOf(index, SHELL).status, "ok");
});
