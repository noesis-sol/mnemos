// The fetcher lease changing holders, in process: two Fetchers (dist/fetcher.js),
// each on its own IndexStore over one index file, with injected clocks, a short
// leaseTtlMs and a fake fetch. A holder whose heartbeat stops (its process
// stalled) loses the lease once the clock passes the TTL, the other takes it
// over and fetches, and the first, when it resumes, finds the lease gone and
// fetches nothing more; a lease that lapsed with nobody taking it over is kept.
// Two fetchers with different skip lists taking the lease in turn: each change
// of holder applies the new holder's policy and retries the needs_login and
// fetch-skipped pages once, and nothing again until the next change or
// REFRESH_MS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexStore } from "../dist/index-store.js";
import { Fetcher, LEASE_NAME, REFRESH_MS } from "../dist/fetcher.js";

const TTL = 1_000;

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
    await sleep(10);
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

function html(url, body) {
  return { status: "ok", kind: "html", url, httpStatus: 200, contentType: "text/html", charset: "utf-8", html: body };
}

/** Entries as lib.allBookmarks gives them: [url, folder]. */
function entries(list) {
  return list.map(([url, folder]) => ({ folder, node: { type: "url", name: `Title of ${url}`, url } }));
}

/** An index file with a page row for each bookmark, as the title indexer leaves it. */
function sharedIndex(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-lease-"));
  dirs.push(dir);
  const bookmarksFile = path.join(dir, "Bookmarks");
  fs.writeFileSync(bookmarksFile, "{}");
  const store = IndexStore.open({ bookmarksFile, dir });
  store.syncBookmarks(
    list.map(([url, folder], i) => ({ guid: `g-${i}`, url, title: `Title of ${url}`, folder_path: folder, text_hash: `h-${i}` })),
  );
  store.close();
  const read = (fn) => {
    const s = IndexStore.open({ bookmarksFile, dir });
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  return { dir, bookmarksFile, read, page: (url) => read((s) => s.getPage(url)) };
}

/** A fetcher on its own store over the index, with its own clock (a function) and fetch. */
function fetcherOn(index, list, { now, fetch, env = {}, ...options }) {
  return new Fetcher({
    env,
    bookmarksFile: () => index.bookmarksFile,
    entries: () => entries(list),
    dir: index.dir,
    fetch,
    domainGapMs: 0,
    leaseTtlMs: TTL,
    heartbeatMs: 20,
    idlePollMs: 10,
    now,
    ...options,
  });
}

test("lease: a holder whose heartbeat stops loses the lease to the other, and fetches nothing more when it resumes", async () => {
  const urls = ["https://a.example/", "https://b.example/", "https://c.example/"];
  const list = urls.map((url) => [url, "Bar"]);
  const index = sharedIndex(list);
  let clock = Date.UTC(2026, 0, 1);
  const now = () => clock;

  // A's first fetch hangs until the test lets it answer: its process stalls mid-fetch.
  const callsA = [];
  let resume;
  const stalled = new Promise((resolve) => (resume = resolve));
  const fetchA = async (url, options) => {
    callsA.push(url);
    if (callsA.length === 1) await stalled;
    if (options.signal?.aborted) return { status: "failed", reason: "aborted", url };
    return html(url, article("aardvark"));
  };
  const callsB = [];
  const fetchB = async (url) => {
    callsB.push(url);
    await sleep(1);
    return html(url, article("bilby"));
  };

  // A fetches one page at a time, and its heartbeat never comes round again in this test.
  const a = fetcherOn(index, list, { now, fetch: fetchA, concurrency: 1, heartbeatMs: 3_600_000 });
  const b = fetcherOn(index, list, { now, fetch: fetchB });
  try {
    a.start();
    b.start();
    assert.equal(a.isHolder(), true);
    assert.equal(b.isHolder(), false);
    await until(() => callsA.length === 1, "A's first fetch");
    const inFlight = callsA[0];

    // Within the TTL B keeps to standby, however often it beats.
    clock += TTL - 1;
    await sleep(100);
    assert.equal(b.isHolder(), false);
    assert.equal(b.status().state, "standby");
    assert.deepEqual(callsB, []);

    // Past the TTL with no renewal: B takes the lease over and fetches every page, A's in flight too.
    clock += 2;
    await until(() => b.isHolder() && b.status().state === "idle", "B to take over and finish");
    assert.deepEqual([...callsB].sort(), urls);
    for (const url of urls) assert.equal(index.page(url).status, "ok", url);
    const holder = index.read((s) => s.getLease(LEASE_NAME)).holder;

    // A resumes: its fetch answers, and A finds the lease gone. It stores nothing and fetches no more.
    const byB = index.page(inFlight);
    resume();
    await until(() => !a.isHolder(), "A to see it lost the lease");
    await a.idle();
    await sleep(100);
    assert.equal(a.status().state, "standby");
    assert.deepEqual(callsA, [inFlight], "A's queued pages are B's alone");
    assert.deepEqual(index.page(inFlight), byB, "A's late answer is not stored over B's");
    assert.match(index.page(inFlight).text, /bilby/);
    assert.equal(index.read((s) => s.getLease(LEASE_NAME)).holder, holder, "B keeps the lease");
    assert.equal(b.isHolder(), true);
    assert.equal(callsB.length, urls.length, "and nothing is fetched twice by B");
  } finally {
    a.stop();
    b.stop();
  }
});

test("lease: a holder whose lease lapsed with nobody taking it over keeps it, and stores and fetches on", async () => {
  const urls = ["https://a.example/", "https://b.example/"];
  const list = urls.map((url) => [url, "Bar"]);
  const index = sharedIndex(list);
  let clock = Date.UTC(2026, 0, 1);
  const calls = [];
  let resume;
  const stalled = new Promise((resolve) => (resume = resolve));
  const fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) await stalled;
    return html(url, article("quokka"));
  };
  const a = fetcherOn(index, list, { now: () => clock, fetch, concurrency: 1, heartbeatMs: 3_600_000 });
  try {
    a.start();
    await until(() => calls.length === 1, "the first fetch");
    clock += TTL + 1;
    resume();
    await until(() => a.status().state === "idle", "both pages");
    assert.equal(a.isHolder(), true);
    assert.deepEqual([...calls].sort(), urls);
    for (const url of urls) assert.equal(index.page(url).status, "ok", url);
    assert.ok(index.read((s) => s.getLease(LEASE_NAME)).expires_at > clock, "the lease is renewed");
  } finally {
    a.stop();
  }
});

test("lease: holders with different skip lists in turn: each change applies its policy and retries needs_login and fetch-skipped pages once", async () => {
  const ok = "https://ok.example/";
  const login = "https://login.example/";
  // The fetch follows a redirect to a private address: skipped by the fetch, not by a list.
  const moved = "https://moved.example/";
  const domain = "https://dom.example/";
  const work = "https://work.example/";
  const list = [
    [ok, "Bar"],
    [login, "Bar"],
    [moved, "Bar"],
    [domain, "Bar"],
    [work, "Bar › Work"],
  ];
  const index = sharedIndex(list);
  const calls = { a: [], b: [] };
  const fetchAs = (who) => async (url) => {
    calls[who].push(url);
    await sleep(1);
    if (url === login) return html(url, LOGIN);
    if (url === moved) return { status: "skipped", reason: "private-address", url: "https://10.0.0.1/" };
    return html(url, article("numbat"));
  };
  // Each its own clock, so a handover is one clock passing the other's lease.
  const clocks = { a: Date.UTC(2026, 0, 1), b: Date.UTC(2026, 0, 1) };
  // A skips dom.example; B skips the Work folder.
  const a = fetcherOn(index, list, { now: () => clocks.a, fetch: fetchAs("a"), env: { MNEMOS_SKIP_DOMAINS: "dom.example" } });
  const b = fetcherOn(index, list, { now: () => clocks.b, fetch: fetchAs("b"), env: { MNEMOS_SKIP_FOLDERS: "work" } });
  const sorted = (urls) => [...urls].sort();
  /** Many heartbeats and idle polls of both: what each fetched meanwhile. */
  const quiet = async () => {
    const before = { a: calls.a.length, b: calls.b.length };
    await sleep(150);
    await a.idle();
    await b.idle();
    return { a: calls.a.slice(before.a), b: calls.b.slice(before.b) };
  };
  /** Moves `to`'s clock past `from`'s lease and waits until `to` holds it, is done, and `from` has stood down. */
  const take = async (to, toFetcher, fromFetcher, from) => {
    const before = calls[to].length;
    const fromBefore = calls[from].length;
    clocks[to] = clocks[from] + TTL + 1;
    await until(
      () => toFetcher.isHolder() && toFetcher.status().state === "idle" && fromFetcher.status().state === "standby",
      `${to} to take the lease over`,
    );
    await a.idle();
    await b.idle();
    assert.deepEqual(calls[from].slice(fromBefore), [], `${from} fetches nothing once ${to} holds the lease`);
    return calls[to].slice(before);
  };
  try {
    a.start();
    b.start();
    assert.equal(a.isHolder(), true);
    await until(() => a.status().state === "idle", "A's first pass");
    assert.deepEqual(sorted(calls.a), sorted([ok, login, moved, work]));
    assert.equal(index.page(ok).status, "ok");
    assert.equal(index.page(login).status, "needs_login");
    assert.equal(index.page(moved).status, "skipped");
    assert.equal(index.page(moved).reason, "private-address");
    assert.equal(index.page(domain).status, "skipped");
    assert.equal(index.page(domain).reason, "skip-domain");
    assert.equal(index.page(work).status, "ok");
    assert.deepEqual(await quiet(), { a: [], b: [] }, "nothing again under A");

    // To B: dom.example is fetched, the Work folder skipped (its text dropped), and the
    // needs_login and fetch-skipped pages retried once; the ok page is not due.
    let fetched = await take("b", b, a, "a");
    assert.deepEqual(sorted(fetched), sorted([login, moved, domain]));
    assert.equal(index.page(domain).status, "ok");
    assert.equal(index.page(work).status, "skipped");
    assert.equal(index.page(work).reason, "skip-folder");
    assert.equal(index.page(work).text, null);
    assert.equal(index.page(login).status, "needs_login");
    assert.equal(index.page(login).fetched_at, clocks.b);
    assert.equal(index.page(moved).fetched_at, clocks.b);
    assert.deepEqual(await quiet(), { a: [], b: [] }, "nothing again under B");

    // Back to A: dom.example skipped again, the Work folder's page fetched again, and the
    // needs_login and fetch-skipped pages retried once more.
    fetched = await take("a", a, b, "b");
    assert.deepEqual(sorted(fetched), sorted([login, moved, work]));
    assert.equal(index.page(domain).status, "skipped");
    assert.equal(index.page(domain).reason, "skip-domain");
    assert.equal(index.page(domain).text, null);
    assert.equal(index.page(work).status, "ok");
    assert.equal(index.page(login).fetched_at, clocks.a);
    assert.deepEqual(await quiet(), { a: [], b: [] }, "nothing again under A");

    // And to B once more: the same retries, once.
    fetched = await take("b", b, a, "a");
    assert.deepEqual(sorted(fetched), sorted([login, moved, domain]));
    assert.deepEqual(await quiet(), { a: [], b: [] }, "nothing again under B");
    const changed = clocks.b;

    // With no change of holder, nothing is retried before REFRESH_MS. B's clock jumps a
    // day short of it (its lease lapses on that clock, but nobody took it, so B keeps it);
    // A's clock stays behind, so A cannot take it.
    clocks.b = changed + REFRESH_MS - 24 * 60 * 60_000;
    await until(() => b.isHolder() && b.status().state === "idle", "B to hold the lease again");
    assert.deepEqual(await quiet(), { a: [], b: [] }, "nothing before REFRESH_MS");

    // At REFRESH_MS after the last change every fetched page is due again, once.
    clocks.b = changed + REFRESH_MS;
    const before = calls.b.length;
    await until(() => index.page(login).fetched_at === clocks.b && b.status().state === "idle", "the refresh");
    await b.idle();
    assert.deepEqual(sorted(calls.b.slice(before)), sorted([ok, login, moved, domain]), "the Work folder's page stays skipped");
    assert.equal(a.isHolder(), false);
    assert.deepEqual(await quiet(), { a: [], b: [] }, "and not again");
  } finally {
    a.stop();
    b.stop();
  }
});
