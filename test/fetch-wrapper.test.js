// safeFetch against local node:http and node:https servers on 127.0.0.1, let
// through the private-address block by MNEMOS_FETCH_ALLOW_HOSTS: https first
// with the http fallback, redirects, the size cap, the timeout, non-HTML and
// refusals. Names other than IP literals go through an injected resolver that
// knows only test names, so nothing here can reach the internet.
// node:test runs each test file in its own process, so setting process.env
// here cannot leak into other test files.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import * as f from "../dist/fetch.js";

process.env.MNEMOS_FETCH_ALLOW_HOSTS = "127.0.0.1";

const tls = new URL("./fixtures/tls/", import.meta.url);
const cert = fs.readFileSync(new URL("localhost.crt", tls));
const key = fs.readFileSync(new URL("localhost.key", tls));

const MB = 1024 * 1024;
const html = (res, body, type = "text/html; charset=utf-8") => {
  res.writeHead(200, { "Content-Type": type });
  res.end(body);
};

/** Routes shared by the plain and the TLS server; `scheme` says which one answered. */
function routes(scheme, seen) {
  return (req, res) => {
    seen.push({ scheme, url: req.url, headers: req.headers });
    const u = new URL(req.url, "http://x");
    const n = Number(u.searchParams.get("n") ?? 0);
    switch (u.pathname) {
      case "/page":
        return html(res, `<title>${scheme}</title>`);
      case "/xhtml":
        return html(res, "<html/>", "application/xhtml+xml");
      case "/latin1":
        return html(res, Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=ISO-8859-1");
      case "/gzip":
        res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
        return res.end(zlib.gzipSync("<p>unzipped</p>"));
      case "/pdf":
        res.writeHead(200, { "Content-Type": "application/pdf" });
        return res.end("%PDF-1.7");
      case "/no-type":
        res.writeHead(200);
        return res.end("<p>?</p>");
      case "/big-declared":
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": 5 * MB + 1 });
        return res.end(Buffer.alloc(5 * MB + 1, 0x61));
      case "/big-chunked": {
        res.writeHead(200, { "Content-Type": "text/html" });
        const chunk = Buffer.alloc(MB, 0x61);
        for (let i = 0; i < 5; i++) res.write(chunk);
        return res.end("bb");
      }
      case "/exactly-5mb":
        return html(res, Buffer.alloc(5 * MB, 0x61), "text/html");
      case "/gzip-bomb":
        res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
        return res.end(zlib.gzipSync(Buffer.alloc(6 * MB, 0x61)));
      case "/hang":
        return; // never answers
      case "/slow-body":
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.write("<p>first part"); // and never ends
      case "/403":
        res.writeHead(403, { "Content-Type": "text/html" });
        return res.end("go away");
      case "/429":
        res.writeHead(429, { "Content-Type": "text/html", "Retry-After": "120" });
        return res.end("slow down");
      case "/404":
        res.writeHead(404, { "Content-Type": "text/html" });
        return res.end("not here");
      case "/500":
        res.writeHead(500);
        return res.end();
      case "/redirect": // /redirect?n=3 → 3 more hops, then /page
        res.writeHead(302, { Location: n > 1 ? `/redirect?n=${n - 1}` : "/page" });
        return res.end();
      case "/to": // /to?l=<location>
        res.writeHead(301, { Location: u.searchParams.get("l") });
        return res.end();
      case "/no-location":
        res.writeHead(302);
        return res.end();
      default:
        res.writeHead(404);
        return res.end();
    }
  };
}

const seen = [];
let plain; // http on 127.0.0.1
let secure; // https on 127.0.0.1, self-signed fixture certificate
let closedPort; // nothing listens here
let silent; // answers plain http, but never answers a TLS ClientHello
let T;
let P;
let S;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

before(async () => {
  plain = http.createServer(routes("http", seen));
  secure = https.createServer({ cert, key }, routes("https", seen));
  P = await listen(plain);
  S = await listen(secure);
  // Peeks at the first byte: 0x16 starts a TLS handshake, which is left
  // hanging, as by a firewall that drops port 443; anything else is handed to
  // the plain http server.
  silent = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      if (chunk[0] === 0x16) return;
      socket.pause();
      socket.unshift(chunk);
      plain.emit("connection", socket);
      socket.resume();
    });
  });
  T = await listen(silent);
  const probe = net.createServer();
  closedPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
});

after(() => {
  plain.closeAllConnections();
  secure.closeAllConnections();
  plain.close();
  secure.close();
  silent.close();
});

const viaPlain = (path) => `http://127.0.0.1:${P}${path}`;
const viaSecure = (path) => `http://127.0.0.1:${S}${path}`;
/** Only test names resolve, and only to 127.0.0.1. */
const resolve = async (host) => {
  if (host === "public.example" || host === "evil.example") return [{ address: "127.0.0.1", family: 4 }];
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};

// --- https first, then http --------------------------------------------------

test("https first: an http:// bookmark is fetched over https when the TLS handshake works", async () => {
  const r = await f.safeFetch(viaSecure("/page"), { ca: cert, resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.url, `https://127.0.0.1:${S}/page`);
  assert.equal(r.html, "<title>https</title>");
});

test("http fallback: an https attempt that hits a plain-http port falls back to http", async () => {
  const r = await f.safeFetch(viaPlain("/page"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.url, viaPlain("/page"));
  assert.equal(r.html, "<title>http</title>");
});

test("http fallback: an untrusted (self-signed) certificate falls back to http", async () => {
  const before = seen.length;
  // No `ca`: the https attempt fails verification, so http is tried on the same
  // port — where a TLS server cannot answer it, so the result is a connection failure.
  const r = await f.safeFetch(viaSecure("/page"), { resolve });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "connection");
  assert.equal(r.url, viaSecure("/page"), "the last attempt was the http fallback");
  assert.equal(seen.length, before, "the TLS server served nothing");
});

test("http fallback: an https attempt that hangs in the handshake falls back to http", async () => {
  const started = Date.now();
  const r = await f.safeFetch(`http://127.0.0.1:${T}/page`, {
    resolve,
    timeoutMs: 5_000,
    upgradeConnectTimeoutMs: 200,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.url, `http://127.0.0.1:${T}/page`);
  assert.equal(r.html, "<title>http</title>");
  assert.ok(Date.now() - started < 4_000, "fell back well before the page timeout");
});

test("the https handshake limit is 5 s, inside the 15 s page timeout", () => {
  assert.equal(f.UPGRADE_CONNECT_TIMEOUT_MS, 5_000);
  assert.ok(f.UPGRADE_CONNECT_TIMEOUT_MS < f.FETCH_TIMEOUT_MS);
});

test("http fallback: a refusing port is tried over https, then http, then reported", async () => {
  const r = await f.safeFetch(`http://127.0.0.1:${closedPort}/page`, { resolve });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "connection");
  assert.equal(r.url, `http://127.0.0.1:${closedPort}/page`);
});

test("no fallback on an HTTP error: a 4xx or 5xx over https is the answer", async () => {
  for (const [path, code] of [["/404", 404], ["/500", 500]]) {
    const before = seen.length;
    const r = await f.safeFetch(viaSecure(path), { ca: cert, resolve });
    assert.deepEqual(r, { status: "failed", reason: "http-error", url: `https://127.0.0.1:${S}${path}`, httpStatus: code });
    assert.equal(seen.length, before + 1, "exactly one request");
  }
});

test("an https:// bookmark is never downgraded to http", async () => {
  const r = await f.safeFetch(`https://127.0.0.1:${P}/page`, { resolve });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "connection");
  assert.equal(r.url, `https://127.0.0.1:${P}/page`);
});

// --- connecting to the checked address ---------------------------------------

test("a name is connected through the checked address (no second DNS lookup)", async () => {
  // public.example is not in DNS anywhere; it can only be reached through the
  // injected resolver's answer, which the allow list lets through.
  const config = f.fetchConfig({ MNEMOS_FETCH_ALLOW_HOSTS: `public.example:${S}` });
  const r = await f.safeFetch(`https://public.example:${S}/page`, { config, resolve, ca: cert });
  assert.equal(r.status, "ok");
  assert.equal(r.html, "<title>https</title>");
  assert.equal(seen.at(-1).headers.host, `public.example:${S}`);
});

test("the allow list is per host: the same address under another name is blocked", async () => {
  const r = await f.safeFetch(`https://evil.example:${S}/page`, { resolve, ca: cert });
  assert.deepEqual(r, { status: "skipped", reason: "private-address", url: `https://evil.example:${S}/page` });
});

// --- redirects -------------------------------------------------------------------

test("redirects: followed by hand up to five hops", async () => {
  const r = await f.safeFetch(viaPlain("/redirect?n=5"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.url, viaPlain("/page"));
});

test("redirects: a sixth hop is too many", async () => {
  const r = await f.safeFetch(viaPlain("/redirect?n=6"), { resolve });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "too-many-redirects");
  assert.equal(r.httpStatus, 302);
});

test("redirects: a hop into a private address is stopped", async () => {
  for (const target of ["http://10.0.0.1/admin", "http://[::ffff:192.168.0.1]/", "http://localhost/"]) {
    const r = await f.safeFetch(viaPlain(`/to?l=${encodeURIComponent(target)}`), { resolve });
    assert.equal(r.status, "skipped", target);
    assert.equal(r.reason, "private-address", target);
  }
});

test("redirects: a hop to a name resolving to a private address is stopped", async () => {
  const target = `http://evil.example:${P}/page`;
  const r = await f.safeFetch(viaPlain(`/to?l=${encodeURIComponent(target)}`), { resolve });
  assert.deepEqual(r, { status: "skipped", reason: "private-address", url: target });
});

test("redirects: a hop to a token URL, another scheme or a skipped domain is stopped", async () => {
  const config = f.fetchConfig({ MNEMOS_FETCH_ALLOW_HOSTS: "127.0.0.1", MNEMOS_SKIP_DOMAINS: "skip.example" });
  const cases = [
    [viaPlain("/page?session=abc"), "token-like"],
    ["https://example.org/auth/logout", "token-like"],
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["https://www.skip.example/", "skip-domain"],
  ];
  for (const [target, reason] of cases) {
    const before = seen.length;
    const r = await f.safeFetch(viaPlain(`/to?l=${encodeURIComponent(target)}`), { config, resolve });
    assert.equal(r.status, "skipped", target);
    assert.equal(r.reason, reason, target);
    assert.equal(seen.length, before + 1, "the redirect target was never requested");
  }
});

test("redirects: a 3xx without Location is a bad redirect", async () => {
  const r = await f.safeFetch(viaPlain("/no-location"), { resolve });
  assert.equal(r.reason, "bad-redirect");
});

// --- size cap ------------------------------------------------------------------------

test("size cap: a declared Content-Length over 5 MB is refused up front", async () => {
  const r = await f.safeFetch(viaPlain("/big-declared"), { resolve });
  assert.deepEqual(r, { status: "failed", reason: "too-large", url: viaPlain("/big-declared") });
});

test("size cap: a chunked body is aborted once it passes 5 MB", async () => {
  const r = await f.safeFetch(viaPlain("/big-chunked"), { resolve });
  assert.equal(r.reason, "too-large");
});

test("size cap: the cap applies to the decompressed body", async () => {
  const r = await f.safeFetch(viaPlain("/gzip-bomb"), { resolve });
  assert.equal(r.reason, "too-large");
});

test("size cap: exactly 5 MB is still fetched", async () => {
  const r = await f.safeFetch(viaPlain("/exactly-5mb"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.html.length, 5 * MB);
});

// --- timeout ---------------------------------------------------------------------------

test("timeout: a server that never answers times out", async () => {
  const started = Date.now();
  const r = await f.safeFetch(viaPlain("/hang"), { resolve, timeoutMs: 300 });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "timeout");
  assert.ok(Date.now() - started < 5_000);
});

test("timeout: a body that never ends times out", async () => {
  const r = await f.safeFetch(viaPlain("/slow-body"), { resolve, timeoutMs: 300 });
  assert.equal(r.reason, "timeout");
});

// --- content types, encodings, refusals --------------------------------------------------

test("non-HTML: a response with no Content-Type, or a PDF with acceptPdf false, is skipped as not-html", async () => {
  for (const [path, options] of [["/no-type", {}], ["/pdf", { acceptPdf: false }]]) {
    const r = await f.safeFetch(viaPlain(path), { resolve, ...options });
    assert.deepEqual(r, { status: "skipped", reason: "not-html", url: viaPlain(path) });
  }
});

test("HTML: application/xhtml+xml is accepted; charset and gzip are decoded", async () => {
  const xhtml = await f.safeFetch(viaPlain("/xhtml"), { resolve });
  assert.equal(xhtml.status, "ok");
  assert.equal(xhtml.kind, "html");
  assert.equal(xhtml.contentType, "application/xhtml+xml");
  const latin1 = await f.safeFetch(viaPlain("/latin1"), { resolve });
  assert.equal(latin1.html, "café");
  assert.equal(latin1.charset, "windows-1252", "the encoding ISO-8859-1 names, as in a browser");
  const gz = await f.safeFetch(viaPlain("/gzip"), { resolve });
  assert.equal(gz.html, "<p>unzipped</p>");
});

test("403 and 429 are refused, with Retry-After when given, and not retried", async () => {
  const before = seen.length;
  assert.deepEqual(await f.safeFetch(viaPlain("/403"), { resolve }), {
    status: "refused",
    httpStatus: 403,
    url: viaPlain("/403"),
  });
  assert.deepEqual(await f.safeFetch(viaPlain("/429"), { resolve }), {
    status: "refused",
    httpStatus: 429,
    url: viaPlain("/429"),
    retryAfterMs: 120_000,
  });
  assert.equal(seen.length, before + 2, "one request each");
});

test("requests carry the browser-like User-Agent and Accept-Language", async () => {
  await f.safeFetch(viaPlain("/page"), { resolve });
  const { headers } = seen.at(-1);
  assert.equal(headers["user-agent"], f.USER_AGENT);
  assert.equal(headers["accept-language"], f.acceptLanguage());
  assert.match(headers.accept, /text\/html/);
});

test("without MNEMOS_FETCH_ALLOW_HOSTS the local server is unreachable", async () => {
  const r = await f.safeFetch(viaPlain("/page"), { config: f.fetchConfig({}), resolve });
  assert.equal(r.reason, "private-address");
});
