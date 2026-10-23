// e2e: a real headless browser (dist/headless.js's HeadlessBrowser) that
// hangs on a page or crashes under one, against a fixture site on 127.0.0.1
// allowed with MNEMOS_FETCH_ALLOW_HOSTS. A page whose response never ends
// fails with reason timeout within the render's time limit; a browser killed
// mid-page (by the PID of the one this test's HeadlessBrowser launched) fails
// that render without throwing, and the next render launches a fresh browser
// that renders its page. The temporary profile is removed in both cases.
// Skipped when no Chromium-based browser is installed (resolveBrowser) or
// playwright-core is missing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchConfig } from "../dist/fetch.js";
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
 * The fixture site. /hang sends its headers and the start of its HTML, and
 * never the rest; /spa is a shell whose script writes its text.
 */
async function fixtureSite() {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/favicon.ico") hits.push(req.url); // Chrome asks for it on its own
    switch (req.url) {
      case "/hang":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.write("<!doctype html><html><head><title>Never done</title></head><body><p>Loading");
        return; // and never ends
      case "/spa":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><title>Rendered</title></head><body><div id="root"></div>
<script>document.getElementById("root").textContent = "Written by script after the crash";</script></body></html>`);
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

/** A HeadlessBrowser for the fixture site, with its profiles in a temporary directory. */
function browserFor(site, options = {}) {
  const env = { MNEMOS_FETCH_ALLOW_HOSTS: site.host };
  const profiles = tempDir("mnemos-headless-crash-profiles-");
  // the browser skipReason found: env lacks the prefixes Windows installs under (LOCALAPPDATA, PROGRAMFILES)
  const browser = new HeadlessBrowser({ env, resolve: () => resolveBrowser(), tmpDir: profiles, ...options });
  return { browser, profiles, config: fetchConfig(env) };
}

test("e2e: a page whose response never ends fails with reason timeout within the time limit", async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const site = await fixtureSite();
  const timeoutMs = 2_000;
  const { browser, profiles, config } = browserFor(site, { timeoutMs });
  try {
    // Started first, so the limit is the page's alone.
    assert.deepEqual(await browser.launch(), { ok: true });
    const profile = await browser.profileDir();
    assert.ok(profile && fs.existsSync(profile), "the browser has its temporary profile");

    const started = Date.now();
    const outcome = await browser.render(site.url("/hang"), { config });
    const took = Date.now() - started;
    assert.deepEqual(outcome, { status: "failed", reason: "timeout", url: site.url("/hang") });
    assert.deepEqual(site.hits, ["/hang"], "the page was requested, and hung");
    assert.ok(took >= timeoutMs - 100, `it waited out the limit (${took} ms)`);
    // The page closes after the limit; a loaded machine takes a while for that.
    assert.ok(took < timeoutMs + 5_000, `it gave up at the limit (${took} ms)`);

    await browser.close();
    await until(() => !fs.existsSync(profile), "the temporary profile to be deleted");
    assert.deepEqual(fs.readdirSync(profiles), [], "no profile left behind");
  } finally {
    await browser.close();
    await site.close();
  }
});

test("e2e: a browser killed mid-page fails that page; the next page gets a fresh browser", async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const site = await fixtureSite();
  const { browser, profiles, config } = browserFor(site);
  try {
    assert.deepEqual(await browser.launch(), { ok: true });
    const profile = await browser.profileDir();
    const pid = await browser.browserPid();
    assert.ok(Number.isInteger(pid) && pid > 0, `the browser's PID (${pid})`);

    // render never throws: a rejection here fails the test.
    const rendering = browser.render(site.url("/hang"), { config });
    await until(() => site.hits.includes("/hang"), "the browser to request the page");
    process.kill(pid, "SIGKILL");
    const outcome = await rendering;
    assert.equal(outcome.status, "failed", JSON.stringify(outcome));
    assert.notEqual(outcome.reason, "timeout", "failed by the crash, not the time limit");
    await until(() => !fs.existsSync(profile), "the dead browser's profile to be deleted");

    // The next page launches a new browser, with a new profile, and renders.
    const next = await browser.render(site.url("/spa"), { config });
    assert.equal(next.status, "ok", JSON.stringify(next));
    assert.match(next.html, /Written by script after the crash/);
    const fresh = await browser.browserPid();
    assert.ok(fresh && fresh !== pid, `a fresh browser (${fresh}, was ${pid})`);
    const freshProfile = await browser.profileDir();
    assert.ok(freshProfile && freshProfile !== profile && fs.existsSync(freshProfile), "with a fresh profile");

    await browser.close();
    await until(() => !fs.existsSync(freshProfile), "the fresh profile to be deleted");
    assert.deepEqual(fs.readdirSync(profiles), [], "no profile left behind");
  } finally {
    await browser.close();
    await site.close();
  }
});
