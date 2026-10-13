// e2e: redirects the headless browser follows for the page itself are checked
// like safeFetch checks them (dist/headless.js's HeadlessBrowser, in a real
// browser), against a fixture site on 127.0.0.1 allowed with
// MNEMOS_FETCH_ALLOW_HOSTS. A page that redirects, in two hops, to a
// token-like logout URL is skipped token-like and the logout URL is never
// requested; a page that redirects to a page the policy allows renders there.
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

/** The fixture site: /bounce redirects through /hop to the logout URL, /moved to /article. */
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
