// e2e: JavaScript-only pages rendered in a real headless browser
// (dist/fetcher.js with safeFetch and dist/headless.js's HeadlessBrowser),
// against a fixture site on 127.0.0.1 allowed with MNEMOS_FETCH_ALLOW_HOSTS.
// A page that builds its text with JavaScript ends ok with that text; its
// requests to a blocked host (localhost, not allowed) are aborted, directly
// or through a redirect, and its images never load; the temporary profile is
// gone once the browser closes. Skipped when no Chromium-based browser is
// installed (resolveBrowser) or playwright-core is missing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import { Fetcher } from "../dist/fetcher.js";
import { HeadlessBrowser, resolveBrowser } from "../dist/headless.js";

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Why this machine cannot run the test, or undefined. */
async function skipReason() {
  const browser = resolveBrowser();
  if (!browser.ok) return `no Chromium-based browser found (${browser.reason}); set MNEMOS_BROWSER to run it`;
  try {
    await import("playwright-core");
  } catch {
    return "playwright-core is not installed";
  }
  return undefined;
}

/**
 * The fixture site. /spa is a shell whose script writes its paragraphs after
 * a timer and a request for /words.json, then tries the blocked host twice:
 * directly, and through /hop, a redirect to it. It records what happened in
 * the page itself.
 */
async function fixtureSite() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    const port = server.address().port;
    const blocked = `http://localhost:${port}/secret`;
    switch (new URL(req.url, "http://x").pathname) {
      case "/spa":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><title>Rendered</title></head><body>
<div id="root"></div><img src="/pixel.png">
<script>
const root = document.getElementById("root");
const article = document.createElement("article");
const say = (text) => { const p = document.createElement("p"); p.textContent = text; article.append(p); };
const tryFetch = (url) => fetch(url).then((r) => r.text()).then((t) => "reached " + t, () => "blocked");
setTimeout(async () => {
  const words = await fetch("/words.json").then((r) => r.json());
  for (let i = 1; i <= 6; i++) {
    say("Paragraph " + i + " written by script about the " + words.animal +
      ": where it lives, what it eats, and why a page about it is worth keeping for later.");
  }
  root.append(article);
  say("direct request " + await tryFetch(${JSON.stringify(blocked)}));
  say("redirected request " + await tryFetch("/hop"));
}, 100);
</script></body></html>`);
        return;
      case "/words.json":
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ animal: "quoll" }));
        return;
      case "/hop":
        res.writeHead(302, { Location: blocked }).end();
        return;
      case "/secret":
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("SECRET");
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    hits,
    host,
    url: (p) => `http://${host}${p}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test("e2e: a page built by JavaScript ends ok with its text; requests to a blocked host are aborted", async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const site = await fixtureSite();
  const dir = tempDir("mnemos-headless-render-");
  const profiles = tempDir("mnemos-headless-profiles-");
  const url = site.url("/spa");
  const list = [{ folder: "Bookmarks Bar", node: { type: "url", name: "SPA", url, date_added: "13300000000000000" } }];
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(bookmarkRows(list));
  store.close();

  const env = { MNEMOS_FETCH_ALLOW_HOSTS: site.host };
  const renderer = new HeadlessBrowser({ env, tmpDir: profiles });
  const fetcher = new Fetcher({ env, bookmarksFile: () => bookmarksFile, entries: () => list, dir, renderer, heartbeatMs: 60_000 });
  const read = () => {
    const index = IndexStore.open({ bookmarksFile, dir });
    try {
      return index.getPage(url);
    } finally {
      index.close();
    }
  };
  let page;
  try {
    fetcher.start();
    page = await until(() => {
      const row = read();
      return row && !["pending", "needs_browser"].includes(row.status) ? row : null;
    }, "the page to be rendered");
    // The browser closes once no page needs it, and its profile goes with it.
    // Closing Chromium can take many seconds on a loaded machine, so this
    // gets the same generous wait as the render itself.
    await until(() => fs.readdirSync(profiles).length === 0, "the temporary profile to be deleted");
  } finally {
    fetcher.stop();
    await renderer.close();
    await site.close();
  }

  assert.equal(page.status, "ok", `${page.status}: ${page.reason}`);
  assert.match(page.text, /Paragraph 1 written by script about the quoll/);
  assert.match(page.text, /Paragraph 6 written by script/);
  assert.match(page.text, /direct request blocked/);
  assert.match(page.text, /redirected request blocked/);
  assert.doesNotMatch(page.text, /SECRET/);
  assert.equal(page.final_url, url);

  assert.deepEqual(
    site.hits.filter((hit) => hit.includes("/secret")),
    [],
    "the blocked host was never reached, directly or through the redirect",
  );
  assert.ok(site.hits.includes(`${site.host}/hop`), "the redirect itself was requested");
  assert.ok(site.hits.includes(`${site.host}/words.json`), "the page's own requests went through");
  assert.ok(!site.hits.some((hit) => hit.endsWith("/pixel.png")), "images are not loaded");
  assert.equal(site.hits.filter((hit) => hit === `${site.host}/spa`).length, 2, "fetched plainly, then rendered");
});
