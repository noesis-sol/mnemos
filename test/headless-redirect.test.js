// e2e: redirects the headless browser follows for the page itself are checked
// like safeFetch checks them (dist/headless.js's HeadlessBrowser, in a real
// browser), against a fixture site on 127.0.0.1 allowed with
// MNEMOS_FETCH_ALLOW_HOSTS. A page that redirects, in two hops, to a
// token-like logout URL is skipped token-like and the logout URL is never
// requested; a page that redirects to a page the policy allows renders there.
// A page whose script or meta refresh navigates to the logout URL is skipped
// too, not stored as Chrome's error page; one whose script navigates to a host
// that does not resolve is refused (http) or failed (https).
// Skipped when no Chromium-based browser is installed
// (resolveBrowser) or playwright-core is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchConfig } from "../dist/fetch.js";
import { HeadlessBrowser, resolveBrowser } from "../dist/headless.js";

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

const LOGOUT = "/account/logout?token=abc";

/**
 * The fixture site: /bounce redirects through /hop to the logout URL, /moved to
 * /article; /scripted's script and /refresh's meta refresh go to the logout URL,
 * /nowhere's and /nowhere-tls's scripts to a host that does not resolve.
 */
async function fixtureSite() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    switch (new URL(req.url, "http://x").pathname) {
      case "/bounce":
        res.writeHead(302, { Location: "/hop" }).end();
        return;
      case "/hop":
        res.writeHead(301, { Location: LOGOUT }).end();
        return;
      case "/moved":
        res.writeHead(302, { Location: "/article" }).end();
        return;
      case "/article":
        html(`<!doctype html><title>Article</title><p id="text"></p>
<script>document.getElementById("text").textContent = "written by script";</script>`);
        return;
      case "/scripted":
        html(`<!doctype html><title>Scripted</title><p>before</p>
<script>location.href = ${JSON.stringify(LOGOUT)};</script>`);
        return;
      case "/refresh":
        html(`<!doctype html><title>Refresh</title><meta http-equiv="refresh" content="0; url=${LOGOUT}"><p>before</p>`);
        return;
      case "/nowhere":
        html(`<!doctype html><title>Nowhere</title><p>before</p>
<script>location.href = "http://mnemos-test.invalid/";</script>`);
        return;
      case "/nowhere-tls":
        html(`<!doctype html><title>Nowhere</title><p>before</p>
<script>location.href = "https://mnemos-test.invalid/";</script>`);
        return;
      case "/account/logout":
        html("<p>logged out</p>");
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

test("e2e: a page that redirects to a token-like URL is skipped, and the URL is never requested", async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const site = await fixtureSite();
  const profiles = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-headless-redirect-"));
  const env = { MNEMOS_FETCH_ALLOW_HOSTS: site.host };
  const config = fetchConfig(env);
  const renderer = new HeadlessBrowser({ env, tmpDir: profiles });
  try {
    const bounced = await renderer.render(site.url("/bounce"), { config });
    assert.deepEqual(bounced, { status: "skipped", reason: "token-like", url: site.url(LOGOUT) });

    const moved = await renderer.render(site.url("/moved"), { config });
    assert.equal(moved.status, "ok", JSON.stringify(moved));
    assert.equal(moved.url, site.url("/article"));
    assert.match(moved.html, /written by script/);

    const direct = await renderer.render(site.url(LOGOUT), { config });
    assert.deepEqual(direct, { status: "skipped", reason: "token-like", url: site.url(LOGOUT) });
  } finally {
    await renderer.close();
    await site.close();
    fs.rmSync(profiles, { recursive: true, force: true, maxRetries: 5 });
  }

  assert.deepEqual(site.hits.filter((hit) => hit.startsWith("/account/logout")), [], "the logout URL was never requested");
  assert.deepEqual(site.hits, ["/bounce", "/hop", "/moved", "/article"]);
});

test("e2e: a page whose script or meta refresh navigates where the policy refuses is not stored as the error page it lands on", async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const site = await fixtureSite();
  const profiles = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-headless-redirect-"));
  const env = { MNEMOS_FETCH_ALLOW_HOSTS: site.host };
  const config = fetchConfig(env);
  const renderer = new HeadlessBrowser({ env, tmpDir: profiles });
  try {
    const scripted = await renderer.render(site.url("/scripted"), { config });
    assert.deepEqual(scripted, { status: "skipped", reason: "token-like", url: site.url(LOGOUT) });

    const refreshed = await renderer.render(site.url("/refresh"), { config });
    assert.deepEqual(refreshed, { status: "skipped", reason: "token-like", url: site.url(LOGOUT) });

    // The proxy answers a plain http request it refuses with a 403, as it does the page itself.
    const nowhere = await renderer.render(site.url("/nowhere"), { config });
    assert.deepEqual(nowhere, { status: "refused", httpStatus: 403, url: "http://mnemos-test.invalid/" });

    // It refuses an https tunnel, and Chrome shows its error page.
    const tls = await renderer.render(site.url("/nowhere-tls"), { config });
    assert.equal(tls.status, "failed", JSON.stringify(tls).slice(0, 300));
    assert.equal(tls.reason, "connection");
    assert.equal(tls.url, site.url("/nowhere-tls"));
  } finally {
    await renderer.close();
    await site.close();
    fs.rmSync(profiles, { recursive: true, force: true, maxRetries: 5 });
  }

  assert.deepEqual(site.hits, ["/scripted", "/refresh", "/nowhere", "/nowhere-tls"], "the logout URL was never requested");
});
