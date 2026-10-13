// The background page fetcher. Over MCP (the built server, spawned and driven
// with the SDK's client, MNEMOS_EMBEDDER=fake in a temporary MNEMOS_CACHE_DIR),
// against a fixture site on 127.0.0.1 allowed with MNEMOS_FETCH_ALLOW_HOSTS:
// articles reach ok with their text, a login wall needs_login, a JS shell
// needs_browser (rendering is off here), a 404 failed with backoff; one request at a time to the domain,
// a second apart, newest bookmarks first; MNEMOS_FETCH_PAGES=0 fetches
// nothing; the one-time note shows once; two servers on one cache fetch each
// page once; closing stdin aborts a fetch and frees the lease. In process
// (dist/fetcher.js, dist/extract.js): extraction in a worker thread, backoff, the lease, the skip lists, and
// per-domain scheduling with a fake fetch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IndexStore, indexFile, SCHEMA_VERSION } from "../dist/index-store.js";
import { bookmarkRows } from "../dist/indexer.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  FIRST_FETCH_NOTE,
  Fetcher,
  LEASE_NAME,
  REFRESH_MS,
  backoffMs,
  domainKey,
  pageResult,
} from "../dist/fetcher.js";
import { Extractor, extractPage, isLoginUrl } from "../dist/extract.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const dirs = [];
// Every test closes its clients, servers and fetchers first; a directory that will not go is let be.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-page-fetcher-"));
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
    await sleep(50);
  }
}

// --- the fixture site --------------------------------------------------------

function article(word) {
  const paragraph = (n) =>
    `<p>Paragraph ${n} about the ${word}: a long and careful explanation of how the ${word} lives, ` +
    `what it eats, where it sleeps and why people who bookmark pages about it keep coming back to read more.</p>`;
  return (
    `<!doctype html><html><head><title>All about the ${word}</title><style>p { color: red }</style>` +
    `<script>window.app = "</div>";</script></head><body><nav><a href="/">Home</a></nav>` +
    `<article><h1>All about the ${word}</h1>${[1, 2, 3, 4, 5, 6, 7, 8].map(paragraph).join("")}</article>` +
    `<footer>© fixture</footer></body></html>`
  );
}

const PAGES = {
  "/quokka": { body: article("quokka") },
  "/axolotl": { body: article("axolotl") },
  "/pangolin": { body: article("pangolin") },
  "/account": {
    body:
      "<!doctype html><html><head><title>Sign in</title></head><body><h1>Welcome back</h1>" +
      '<form method="post"><label>Email <input type="email" name="email"></label>' +
      '<label>Password <input type="PASSWORD" name="pw"></label><button>Sign in</button></form></body></html>',
  },
  "/members": { status: 302, location: "/signin?next=%2Fmembers" },
  "/signin": {
    body:
      "<!doctype html><html><head><title>Members</title></head><body>" +
      "<p>Please continue with your company account.</p><button>Continue</button></body></html>",
  },
  "/app": {
    body:
      '<!doctype html><html><head><title>App</title><script src="/bundle.js"></script></head>' +
      '<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>',
  },
  "/missing": { status: 404, body: "<!doctype html><html><body><h1>Not found</h1></body></html>" },
  "/slow": { hang: true },
};

/**
 * A node:http server on 127.0.0.1 serving PAGES, each response ~150 ms late,
 * recording every request: its path, start and end, and the most requests
 * it ever had in flight at once.
 */
async function fixtureSite() {
  const site = { requests: [], inFlight: 0, maxInFlight: 0, aborted: [] };
  const server = http.createServer((req, res) => {
    const record = { path: new URL(req.url, "http://x").pathname, start: Date.now(), end: undefined };
    site.requests.push(record);
    site.inFlight++;
    site.maxInFlight = Math.max(site.maxInFlight, site.inFlight);
    let open = true;
    const done = () => {
      if (!open) return;
      open = false;
      site.inFlight--;
      record.end = Date.now();
    };
    res.on("close", () => {
      if (!res.writableFinished) site.aborted.push(record.path);
      done();
    });
    const page = PAGES[record.path];
    if (page?.hang) return; // never answers
    setTimeout(() => {
      if (!page) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("no such page");
      } else if (page.location) {
        res.writeHead(page.status, { Location: page.location }).end();
      } else {
        res.writeHead(page.status ?? 200, { "Content-Type": "text/html; charset=utf-8" }).end(page.body);
      }
      done();
    }, 150);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.server = server;
  site.host = `127.0.0.1:${server.address().port}`;
  site.url = (p) => `http://${site.host}${p}`;
  site.count = (p) => site.requests.filter((r) => r.path === p).length;
  site.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return site;
}

/** Chrome's date_added for `n` seconds after a fixed day in 2022. */
const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

/** A Chrome Bookmarks file of the given paths on the site, the last one newest. */
function writeBookmarks(dir, site, paths) {
  const file = path.join(dir, "Bookmarks");
  const children = paths.map((p, i) => ({
    type: "url",
    name: `Page ${p.slice(1)}`,
    url: site.url(p),
    date_added: chromeTime(i),
  }));
  const folder = (name, kids = []) => ({ type: "folder", name, children: kids });
  const roots = { bookmark_bar: folder("Bookmarks bar", children), other: folder("Other bookmarks"), synced: folder("Mobile bookmarks") };
  fs.writeFileSync(file, JSON.stringify({ checksum: "x", roots, version: 1 }));
  return file;
}

async function startServer({ bookmarks, cache, site, env = {} }) {
  const client = new Client({ name: "mnemos-page-fetcher", version: "0.0.0" });
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
        // No headless browser here: headless-render.test.js renders pages with one.
        MNEMOS_BROWSER: "0",
        ...env,
      },
      stderr: "ignore",
    }),
  );
  return client;
}

async function search(client, query = "quokka") {
  const result = await client.callTool({ name: "semantic_search", arguments: { query } });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

/** The pages table and the fetcher lease, or null while the index is not there yet. */
function readIndex(bookmarks, cache) {
  const file = indexFile(bookmarks, cache);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const pages = new Map(db.prepare("SELECT * FROM pages").all().map((row) => [row.url, row]));
    const lease = db.prepare("SELECT * FROM lease WHERE name = ?").get(LEASE_NAME);
    return { pages, lease };
  } catch {
    return null; // the server is still creating it
  } finally {
    db.close();
  }
}

/** The index once every page of `urls` has left pending. */
function fetchedAll(bookmarks, cache, urls) {
  return until(() => {
    const index = readIndex(bookmarks, cache);
    return index && urls.every((url) => index.pages.get(url) && index.pages.get(url).status !== "pending") ? index : null;
  }, "every page to be fetched");
}

// --- over MCP ----------------------------------------------------------------

const SITE_PATHS = ["/missing", "/app", "/members", "/account", "/pangolin", "/axolotl", "/quokka"];

test("e2e: pages are fetched, extracted and classified, one at a time per domain, newest first", async () => {
  const site = await fixtureSite();
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const bookmarks = writeBookmarks(dir, site, SITE_PATHS);
  const urls = SITE_PATHS.map(site.url);
  const client = await startServer({ bookmarks, cache, site });
  let notices = 0;
  try {
    const startedAt = Date.now();
    const index = await fetchedAll(bookmarks, cache, urls);
    const page = (p) => index.pages.get(site.url(p));

    for (const [p, word] of [["/quokka", "quokka"], ["/axolotl", "axolotl"], ["/pangolin", "pangolin"]]) {
      const row = page(p);
      assert.equal(row.status, "ok", `${p}: ${row.reason}`);
      assert.equal(row.final_url, site.url(p));
      assert.match(row.text, new RegExp(`Paragraph 1 about the ${word}`));
      assert.match(row.text, /Paragraph 5/);
      assert.doesNotMatch(row.text, /\s{2}|\n/, "whitespace is collapsed");
      assert.match(row.text, /read more\. Paragraph 2/);
      assert.doesNotMatch(row.text, /window\.app|color: red/, "no script or style text");
      assert.match(row.content_hash, /^[0-9a-f]{64}$/);
      assert.ok(row.fetched_at >= startedAt);
      assert.equal(row.next_attempt_at, row.fetched_at + REFRESH_MS);
    }

    assert.equal(page("/account").status, "needs_login");
    assert.equal(page("/account").reason, "password field");
    assert.equal(page("/account").text, null);
    assert.equal(page("/members").status, "needs_login");
    assert.equal(page("/members").reason, "login URL");
    assert.equal(page("/members").final_url, site.url("/signin?next=%2Fmembers"));
    // A JS shell waits for a browser, and with rendering off the status says so.
    assert.equal(page("/app").status, "needs_browser");
    assert.match(page("/app").reason, /^\d+ characters of readable text$/);
    assert.equal(page("/app").text, null);

    const missing = page("/missing");
    assert.equal(missing.status, "failed");
    assert.equal(missing.reason, "http-error: HTTP 404");
    assert.equal(missing.fail_count, 1);
    assert.equal(missing.next_attempt_at - missing.fetched_at, BACKOFF_BASE_MS);

    // Each page once (the redirect's target too), never two at a time, a second apart.
    for (const p of [...SITE_PATHS, "/signin"]) assert.equal(site.count(p), 1, p);
    assert.equal(site.maxInFlight, 1);
    const fetches = site.requests.filter((r) => r.path !== "/signin"); // a redirect hop, not a new fetch
    for (let i = 1; i < fetches.length; i++) {
      const gap = fetches[i].start - fetches[i - 1].end;
      assert.ok(gap >= 950, `${fetches[i].path} started ${gap} ms after ${fetches[i - 1].path} ended`);
    }
    // Newest bookmark first: the file lists them oldest first.
    assert.deepEqual(fetches.map((r) => r.path), [...SITE_PATHS].reverse());

    // The one-time note, on the first answer since fetching started and never again.
    for (let i = 0; i < 3; i++) {
      const data = await search(client);
      if (data.notice !== undefined) {
        assert.equal(data.notice, FIRST_FETCH_NOTE);
        notices++;
      }
      assert.equal(data.status.fetching_disabled, false);
      assert.equal(data.status.fetching, "idle");
      assert.equal(data.status.browser, "1 page needs a browser; MNEMOS_BROWSER=0 turns page rendering off");
    }
    assert.equal(notices, 1);
  } finally {
    await client.close();
    await site.close();
  }
  // Released on exit, and the note stays shown for this index across restarts.
  assert.equal(readIndex(bookmarks, cache).lease, undefined);
  const again = await startServer({ bookmarks, cache, site: { host: site.host } });
  try {
    await until(async () => (await search(again)).status.fetching === "idle", "the restarted fetcher to go idle");
    assert.equal((await search(again)).notice, undefined);
  } finally {
    await again.close();
  }
});

test("e2e: MNEMOS_FETCH_PAGES=0 fetches nothing, and the status says so", async () => {
  const site = await fixtureSite();
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const bookmarks = writeBookmarks(dir, site, ["/quokka", "/axolotl"]);
  const client = await startServer({ bookmarks, cache, site, env: { MNEMOS_FETCH_PAGES: "0" } });
  try {
    const data = await until(async () => {
      const answer = await search(client);
      return answer.status.indexing === "ready" ? answer : null;
    }, "the titles to be indexed");
    await sleep(1_500); // when the fetcher would have started
    assert.equal(data.status.fetching_disabled, true);
    assert.equal(data.status.fetching, "disabled");
    assert.equal(data.notice, undefined);
    assert.equal((await search(client)).notice, undefined);
    assert.equal(site.requests.length, 0);
    const index = readIndex(bookmarks, cache);
    assert.equal(index.pages.size, 0);
    assert.equal(index.lease, undefined);
  } finally {
    await client.close();
    await site.close();
  }
});

test("e2e: two servers on one cache directory: only one fetches, each page once", async () => {
  const site = await fixtureSite();
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const paths = ["/quokka", "/axolotl", "/pangolin", "/app", "/missing"];
  const bookmarks = writeBookmarks(dir, site, paths);
  const [a, b] = await Promise.all([startServer({ bookmarks, cache, site }), startServer({ bookmarks, cache, site })]);
  try {
    await fetchedAll(bookmarks, cache, paths.map(site.url));
    await sleep(500); // a second fetcher, had there been one, would be at it by now
    for (const p of paths) assert.equal(site.count(p), 1, p);
    assert.equal(site.maxInFlight, 1);
    const answers = [];
    for (const client of [a, b, a, b]) answers.push(await search(client));
    const states = [answers[0].status.fetching, answers[1].status.fetching].sort();
    assert.deepEqual(states, ["another mnemos process is fetching", "idle"]);
    // The note, taken once between them.
    assert.equal(answers.filter((answer) => answer.notice === FIRST_FETCH_NOTE).length, 1);
    assert.equal(answers[0].notice, FIRST_FETCH_NOTE);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await site.close();
  }
  assert.equal(readIndex(bookmarks, cache).lease, undefined);
});

test("e2e: closing stdin aborts the fetch in flight and frees the lease", async () => {
  const site = await fixtureSite();
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const bookmarks = writeBookmarks(dir, site, ["/slow"]);
  const client = await startServer({ bookmarks, cache, site });
  try {
    await until(() => site.count("/slow") === 1, "the slow page to be requested");
    assert.ok(readIndex(bookmarks, cache).lease, "the lease is held while fetching");
  } finally {
    const closing = Date.now();
    await client.close();
    // The SDK sends SIGTERM after 2 s; the server exits on stdin's end well before.
    assert.ok(Date.now() - closing < 1_900, `took ${Date.now() - closing} ms to exit`);
    await until(() => site.aborted.includes("/slow"), "the slow request to be aborted", 5_000);
    await site.close();
  }
  const index = readIndex(bookmarks, cache);
  assert.equal(index.lease, undefined);
  assert.equal(index.pages.get(site.url("/slow")).status, "pending", "an aborted fetch leaves its page as it was");
});

// Windows has no SIGTERM to catch: there, a process sent one is killed.
test("e2e: SIGTERM aborts the fetch in flight, frees the lease and exits", { skip: process.platform === "win32" }, async () => {
  const site = await fixtureSite();
  const dir = tempDir();
  const cache = path.join(dir, "cache");
  const bookmarks = writeBookmarks(dir, site, ["/slow"]);
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
    env: {
      ...process.env,
      CHROME_BOOKMARKS_PATH: bookmarks,
      MNEMOS_CACHE_DIR: cache,
      MNEMOS_EMBEDDER: "fake",
      MNEMOS_FETCH_ALLOW_HOSTS: site.host,
      MNEMOS_FETCH_PAGES: "",
    },
    stdio: ["pipe", "ignore", "ignore"], // stdin stays open: only the signal ends it
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await until(() => site.count("/slow") === 1, "the slow page to be requested");
    assert.ok(readIndex(bookmarks, cache).lease, "the lease is held while fetching");
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null });
    await until(() => site.aborted.includes("/slow"), "the slow request to be aborted", 5_000);
  } finally {
    child.kill("SIGKILL");
    await site.close();
  }
  assert.equal(readIndex(bookmarks, cache).lease, undefined);
});

// --- extraction ----------------------------------------------------------------

test("extractPage: an article's text, whitespace collapsed, without scripts and styles", () => {
  const result = extractPage(article("wombat"), "https://example.com/wombat");
  assert.equal(result.status, "ok");
  assert.match(result.text, /^All about the wombat|Paragraph 1 about the wombat/);
  assert.match(result.text, /Paragraph 5 about the wombat/);
  assert.doesNotMatch(result.text, /\s{2}|\n|window\.app|color: red/);
  assert.match(result.text, /read more\. Paragraph 2/, "adjacent blocks stay separate words");
  // HTML may leave <html>, <head> and <body> out; linkedom does not add them as a browser would.
  const bare = article("wombat").replace(/<\/?(?:html|head|body)>/g, "");
  assert.match(extractPage(bare, "https://example.com/wombat").text, /Paragraph 1 about the wombat.* Paragraph 8/);
  assert.equal(extractPage("just some words", "https://example.com/").status, "no_content");
});

test("extractPage: login walls, JS shells and short pages", () => {
  assert.deepEqual(extractPage(PAGES["/account"].body, "https://example.com/account"), {
    status: "needs_login",
    reason: "password field",
  });
  assert.deepEqual(extractPage(PAGES["/signin"].body, "https://example.com/users/sign_in"), {
    status: "needs_login",
    reason: "login URL",
  });
  // The same short page elsewhere is just short.
  assert.equal(extractPage(PAGES["/signin"].body, "https://example.com/members").status, "no_content");
  assert.equal(extractPage(PAGES["/app"].body, "https://example.com/app").status, "no_content");
  assert.equal(extractPage("", "https://example.com/").status, "no_content");
  // A long article with a sign-in box beside it is the article.
  const withForm = article("okapi").replace("<footer>", '<form><input type="password"></form><footer>');
  assert.equal(extractPage(withForm, "https://example.com/login").status, "ok");
});

test("Extractor: a 3 MB page is extracted in the worker while the event loop keeps turning", async () => {
  const words = ["quokka", "axolotl", "pangolin", "okapi"];
  const big = article("tapir").replace(
    "</article>",
    `${Array.from({ length: 50_000 }, (_, i) => `<p>Note ${i} on the ${words[i % 4]}, with a few more words to read.</p>`).join("")}</article>`,
  );
  assert.ok(big.length > 3_000_000);
  const extractor = new Extractor();
  try {
    let maxLag = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      maxLag = Math.max(maxLag, Date.now() - last - 10);
      last = Date.now();
    }, 10);
    const started = Date.now();
    const result = await extractor.extract(big, "https://example.com/tapir");
    const took = Date.now() - started;
    clearInterval(ticker);
    assert.equal(result.status, "ok");
    assert.match(result.text, /Note 0 on the quokka/);
    assert.equal(result.text.length, 200_000, "cut at MAX_TEXT_CHARS");
    // Run here, extraction would hold the loop for the whole `took`.
    assert.ok(maxLag < 250, `the event loop stalled ${maxLag} ms (extraction took ${took} ms)`);
    // The worker stays up for the next page.
    assert.equal((await extractor.extract(PAGES["/app"].body, "https://example.com/app")).status, "no_content");
  } finally {
    extractor.close();
  }
});

test("Extractor: a page over the time limit fails, close() fails what waits, and a new worker follows", async () => {
  const extractor = new Extractor(1);
  try {
    await assert.rejects(extractor.extract(article("slow"), "https://example.com/"), /longer than 0.001 s/);
    const waiting = new Extractor();
    const pending = waiting.extract(article("tapir"), "https://example.com/");
    waiting.close();
    await assert.rejects(pending, /extraction stopped/);
    assert.equal((await waiting.extract(article("tapir"), "https://example.com/")).status, "ok");
    waiting.close();
  } finally {
    extractor.close();
  }
});

test("isLoginUrl: sign-in paths, not words that contain them", () => {
  for (const url of [
    "https://example.com/login",
    "https://example.com/accounts/sign-in?next=/x",
    "https://example.com/users/sign_in",
    "https://idp.example.com/oauth/authorize",
    "https://example.com/Login.php",
  ]) {
    assert.equal(isLoginUrl(url), true, url);
  }
  for (const url of ["https://example.com/", "https://example.com/blog/logins-explained", "https://example.com/author/x", "not a url"]) {
    assert.equal(isLoginUrl(url), false, url);
  }
});

// --- results and backoff -------------------------------------------------------

test("backoffMs: from an hour, up to 30 days", () => {
  assert.equal(backoffMs(1), BACKOFF_BASE_MS);
  assert.equal(backoffMs(2), 6 * BACKOFF_BASE_MS);
  assert.equal(backoffMs(4), 7 * 24 * BACKOFF_BASE_MS);
  assert.equal(backoffMs(40), BACKOFF_MAX_MS);
});

test("pageResult: failures back off from the previous count; refusals honour Retry-After", () => {
  const url = "https://example.com/x";
  const failed = pageResult(url, { status: "failed", reason: "http-error", httpStatus: 500, url }, undefined, 2, 1_000);
  assert.equal(failed.status, "failed");
  assert.equal(failed.fail_count, 3);
  assert.equal(failed.next_attempt_at, 1_000 + 24 * BACKOFF_BASE_MS);
  assert.equal(failed.reason, "http-error: HTTP 500");
  const timeout = pageResult(url, { status: "failed", reason: "timeout", url }, undefined, 0, 0);
  assert.equal(timeout.reason, "timeout");
  const month = 31 * 24 * 60 * 60_000;
  const refused = pageResult(url, { status: "refused", httpStatus: 429, url, retryAfterMs: month }, undefined, 0, 0);
  assert.equal(refused.status, "failed");
  assert.equal(refused.reason, "refused: HTTP 429");
  assert.equal(refused.next_attempt_at, month);
  const skipped = pageResult(url, { status: "skipped", reason: "not-html", url }, undefined, 3, 0);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.next_attempt_at, REFRESH_MS);
  const html = { status: "ok", kind: "html", url: `${url}/final`, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: "" };
  const ok = pageResult(url, html, { status: "ok", text: "hello" }, 3, 7);
  assert.equal(ok.status, "ok");
  assert.equal(ok.fail_count, 0);
  assert.equal(ok.final_url, `${url}/final`);
  assert.equal(ok.text, "hello");
  assert.equal(ok.next_attempt_at, 7 + REFRESH_MS);
  const login = pageResult(url, html, { status: "needs_login", reason: "password field" }, 0, 7);
  assert.equal(login.next_attempt_at, 7 + REFRESH_MS);
  assert.equal(pageResult(url, html, { status: "no_content", reason: "0 characters" }, 0, 7).next_attempt_at, null);
  assert.equal(pageResult(url, html, { status: "failed", reason: "extraction failed: x" }, 0, 0).status, "failed");
});

test("domainKey: the host, lower-case, without www", () => {
  assert.equal(domainKey("https://WWW.Example.com/a"), "example.com");
  assert.equal(domainKey("http://127.0.0.1:8080/x"), "127.0.0.1");
  assert.equal(domainKey("https://docs.example.com/"), "docs.example.com");
});

// --- the fetcher, in process -----------------------------------------------------

/** Entries as lib.allBookmarks gives them. */
function entries(list) {
  return list.map(([url, folder = "Bookmarks Bar", added = 0]) => ({
    folder,
    node: { type: "url", name: url, url, date_added: chromeTime(added) },
  }));
}

/** An index for these entries, with the bookmarks synced as the title indexer would. */
function seededIndex(list) {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(bookmarkRows(list));
  store.close();
  return { dir, bookmarksFile };
}

/** A fake fetch: an article page after `delayMs`, recording each call's start and end. */
function fakeFetch(delayMs = 30) {
  const calls = [];
  const fn = async (url, options) => {
    const call = { url, start: Date.now(), end: undefined, folder: options.folder };
    calls.push(call);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    call.end = Date.now();
    if (options.signal?.aborted) return { status: "failed", reason: "aborted", url };
    return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: article("numbat") };
  };
  return { fn, calls };
}

function fetcherFor(index, list, fetch, options = {}) {
  return new Fetcher({
    env: {},
    bookmarksFile: () => index.bookmarksFile,
    entries: () => list,
    dir: index.dir,
    fetch: fetch.fn,
    domainGapMs: 40,
    heartbeatMs: 60_000,
    ...options,
  });
}

function pagesOf(index) {
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    return new Map(store.pageStates().map((p) => [p.url, store.getPage(p.url)]));
  } finally {
    store.close();
  }
}

test("Fetcher: four at a time, one per domain with a rest between, newest first", async () => {
  const list = entries(
    ["a", "b", "c", "d", "e"].flatMap((host, h) =>
      [1, 2, 3].map((n) => [`https://${host}.example/${n}`, "Bookmarks Bar", h * 10 + n]),
    ),
  );
  const index = seededIndex(list);
  const fetch = fakeFetch(30);
  const fetcher = fetcherFor(index, list, fetch);
  try {
    fetcher.start();
    assert.equal(fetcher.isHolder(), true);
    await until(() => fetch.calls.length === list.length && fetcher.status().state === "idle", "every page");
  } finally {
    fetcher.stop();
  }
  // No more than four at once, and never two on one domain or less than domainGapMs apart.
  for (const call of fetch.calls) {
    // In flight as this one starts: two that ran one after the other in a slot overlap this
    // one's window, but were never in flight together.
    const inFlight = fetch.calls.filter((c) => c.start <= call.start && call.start < c.end);
    assert.ok(inFlight.length <= 4, `${inFlight.length} at once`);
    const sameDomain = fetch.calls.filter((c) => c !== call && domainKey(c.url) === domainKey(call.url));
    for (const other of sameDomain) {
      if (other.start < call.start) assert.ok(call.start - other.end >= 35, `${call.url} after ${other.url}`);
    }
  }
  assert.ok(fetch.calls.some((c) => fetch.calls.filter((o) => o.start < c.end && c.start < o.end).length > 1), "domains in parallel");
  // e.example has the newest bookmarks: its newest page goes first.
  assert.equal(fetch.calls[0].url, "https://e.example/3");
  const pages = pagesOf(index);
  assert.equal(pages.size, list.length);
  for (const page of pages.values()) assert.equal(page.status, "ok");
});

test("Fetcher: only the lease holder fetches; the other takes over once it stops", async () => {
  const list = entries([["https://a.example/1"], ["https://b.example/1"]]);
  const index = seededIndex(list);
  const fetchA = fakeFetch(10_000); // still fetching when stopped
  const fetchB = fakeFetch(10);
  const a = fetcherFor(index, list, fetchA);
  const b = fetcherFor(index, list, fetchB, { heartbeatMs: 50 });
  try {
    a.start();
    b.start();
    assert.equal(a.isHolder(), true);
    assert.equal(b.isHolder(), false);
    assert.equal(b.status().state, "standby");
    await until(() => fetchA.calls.length === 2, "the holder's fetches");
    await sleep(150);
    assert.equal(fetchB.calls.length, 0);
    assert.equal(b.takeNote(), FIRST_FETCH_NOTE, "the standby process shows the note too");
    assert.equal(a.takeNote(), undefined, "but only once");

    a.stop(); // aborts both fetches; the pages stay pending
    assert.equal(a.status().state, "stopped");
    assert.equal(pagesOf(index).get("https://a.example/1").status, "pending");
    await until(() => b.isHolder() && b.status().state === "idle", "the other to take over and finish");
    assert.deepEqual(fetchB.calls.map((c) => c.url).sort(), ["https://a.example/1", "https://b.example/1"]);
    assert.equal(b.takeNote(), undefined, "fetching had started for this index already");
  } finally {
    a.stop();
    b.stop();
  }
});

test("Fetcher: MNEMOS_FETCH_PAGES=0 never opens the index or fetches", () => {
  const list = entries([["https://a.example/1"]]);
  const index = seededIndex(list);
  const fetch = fakeFetch();
  const fetcher = fetcherFor(index, list, fetch, { env: { MNEMOS_FETCH_PAGES: "0" } });
  fetcher.start();
  assert.deepEqual(fetcher.status(), { state: "disabled", fetched: 0 });
  assert.equal(fetcher.isHolder(), false);
  assert.equal(fetcher.takeNote(), undefined);
  fetcher.stop();
  assert.equal(fetch.calls.length, 0);
  assert.equal(pagesOf(index).size, 0);
});

test("Fetcher: the skip lists mark pages skipped, drop their text, and let them go again", async () => {
  const list = entries([
    ["https://a.example/1", "Bookmarks Bar › Bank"],
    ["https://b.example/1"],
    ["https://c.example/1"],
  ]);
  const index = seededIndex(list);
  const first = fakeFetch(5);
  let fetcher = fetcherFor(index, list, first, { env: { MNEMOS_SKIP_FOLDERS: "bank" } });
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle", "the first pass");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(first.calls.map((c) => c.url).sort(), ["https://b.example/1", "https://c.example/1"]);
  let pages = pagesOf(index);
  assert.equal(pages.get("https://a.example/1").status, "skipped");
  assert.equal(pages.get("https://a.example/1").reason, "skip-folder");
  assert.equal(pages.get("https://b.example/1").status, "ok");

  // b's domain is skipped now, and the folder is not: b loses its text, a is fetched.
  const second = fakeFetch(5);
  fetcher = fetcherFor(index, list, second, { env: { MNEMOS_SKIP_DOMAINS: "b.example" } });
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && second.calls.length === 1, "the second pass");
  } finally {
    fetcher.stop();
  }
  assert.deepEqual(second.calls.map((c) => c.url), ["https://a.example/1"]);
  pages = pagesOf(index);
  assert.equal(pages.get("https://a.example/1").status, "ok");
  assert.equal(pages.get("https://b.example/1").status, "skipped");
  assert.equal(pages.get("https://b.example/1").reason, "skip-domain");
  assert.equal(pages.get("https://b.example/1").text, null);
  assert.equal(pages.get("https://c.example/1").status, "ok", "an ok page is not fetched again");
});

test("Fetcher: a fetch that throws is recorded on its page, and fetching goes on", async () => {
  const list = entries([["https://a.example/1", "Bookmarks Bar", 2], ["https://b.example/1", "Bookmarks Bar", 1]]);
  const index = seededIndex(list);
  const ok = fakeFetch(5);
  const fetch = {
    calls: ok.calls,
    fn: (url, options) => (url.startsWith("https://a.") ? Promise.reject(new Error("boom")) : ok.fn(url, options)),
  };
  const fetcher = fetcherFor(index, list, fetch);
  try {
    fetcher.start();
    await until(() => fetcher.status().state === "idle" && ok.calls.length === 1, "both pages");
  } finally {
    fetcher.stop();
  }
  const pages = pagesOf(index);
  assert.equal(pages.get("https://a.example/1").status, "failed");
  assert.match(pages.get("https://a.example/1").reason, /boom/);
  assert.equal(pages.get("https://a.example/1").fail_count, 1);
  assert.equal(pages.get("https://b.example/1").status, "ok");
});

// --- the store ---------------------------------------------------------------------

test("store: a version 1 index gains pages.text and keeps its rows", () => {
  const dir = tempDir();
  const bookmarksFile = path.join(dir, "Bookmarks");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(bookmarkRows(entries([["https://a.example/"]])));
  store.upsertPage({ url: "https://a.example/", status: "ok", content_hash: "h" });
  store.close();
  // Back to version 1: no text column.
  const db = new DatabaseSync(indexFile(bookmarksFile, dir));
  db.exec("ALTER TABLE pages DROP COLUMN text");
  db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  db.close();

  const reopened = IndexStore.open({ bookmarksFile, dir });
  try {
    assert.equal(reopened.getMeta("schema_version"), String(SCHEMA_VERSION));
    assert.equal(reopened.getPage("https://a.example/").content_hash, "h");
    assert.equal(reopened.getPage("https://a.example/").text, null);
    reopened.upsertPage({ url: "https://a.example/", status: "ok", text: "the page" });
    // A row written without text keeps the text it has.
    reopened.upsertPage({ url: "https://a.example/", status: "ok", reason: "kept" });
    assert.equal(reopened.getPage("https://a.example/").text, "the page");
    reopened.upsertPage({ url: "https://a.example/", status: "no_content", text: null });
    assert.equal(reopened.getPage("https://a.example/").text, null);
  } finally {
    reopened.close();
  }
});

test("store: pending pages for http(s) bookmarks, due pages, and a note taken once", () => {
  const list = entries([["https://a.example/"], ["HTTP://b.example/"], ["javascript:alert(1)"], ["https://a.example/"]]);
  const index = seededIndex(list);
  const store = IndexStore.open({ bookmarksFile: index.bookmarksFile, dir: index.dir });
  try {
    assert.equal(store.addPendingPages(), 2);
    assert.equal(store.addPendingPages(), 0);
    store.upsertPage({ url: "https://a.example/", status: "failed", fail_count: 1, next_attempt_at: 100 });
    assert.deepEqual(store.duePages(99), ["HTTP://b.example/"]);
    assert.deepEqual(store.duePages(100), ["HTTP://b.example/", "https://a.example/"]);
    assert.deepEqual(store.pageCounts(), { failed: 1, pending: 1 });
    assert.equal(store.addMeta("k", "1"), true);
    assert.equal(store.addMeta("k", "2"), false);
    assert.equal(store.takeMeta("k"), "1");
    assert.equal(store.takeMeta("k"), undefined);
  } finally {
    store.close();
  }
});
