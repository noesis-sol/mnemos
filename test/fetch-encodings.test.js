// safeFetch on the encodings and the address family test/fetch-wrapper.test.js
// leaves out: Brotli and deflate bodies (zlib-wrapped and raw), decoded and held to the 5 MB cap, and
// a page served from a server listening on the IPv6 loopback [::1], let through
// the private-address block by MNEMOS_FETCH_ALLOW_HOSTS. Names other than IP
// literals go through an injected resolver that knows only test names, so
// nothing here can reach the internet.
// node:test runs each test file in its own process, so setting process.env
// here cannot leak into other test files.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import * as f from "../dist/fetch.js";

process.env.MNEMOS_FETCH_ALLOW_HOSTS = "127.0.0.1,[::1],v6.example";

const MB = 1024 * 1024;

function routes(seen) {
  return (req, res) => {
    seen.push({ url: req.url, headers: req.headers, remoteAddress: req.socket.remoteAddress });
    const encoded = (encoding, body) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": encoding });
      res.end(body);
    };
    switch (req.url) {
      case "/page":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<title>over IPv6</title>");
      case "/br":
        return encoded("br", zlib.brotliCompressSync("<p>Brotli décodé</p>"));
      case "/deflate":
        return encoded("deflate", zlib.deflateSync("<p>deflate décodé</p>"));
      case "/deflate-raw":
        return encoded("deflate", zlib.deflateRawSync("<p>raw deflate décodé</p>"));
      case "/deflate-raw-split": {
        // The first byte alone, then the rest: the decoder must wait for two
        // bytes before it can tell raw deflate from a zlib header.
        const body = zlib.deflateRawSync("<p>raw deflate in pieces</p>");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "deflate" });
        res.flushHeaders();
        res.write(body.subarray(0, 1));
        return setTimeout(() => res.end(body.subarray(1)), 20);
      }
      case "/deflate-empty":
        return encoded("deflate", Buffer.alloc(0));
      case "/br-bomb":
        return encoded("br", zlib.brotliCompressSync(Buffer.alloc(6 * MB, 0x61)));
      case "/deflate-bomb":
        return encoded("deflate", zlib.deflateSync(Buffer.alloc(6 * MB, 0x61)));
      case "/deflate-raw-bomb":
        return encoded("deflate", zlib.deflateRawSync(Buffer.alloc(6 * MB, 0x61)));
      case "/br-exactly-5mb":
        return encoded("br", zlib.brotliCompressSync(Buffer.alloc(5 * MB, 0x61)));
      default:
        res.writeHead(404);
        return res.end();
    }
  };
}

const seen = [];
let v4; // http on 127.0.0.1
let v6; // http on [::1], when the machine has an IPv6 loopback
let v6Skip; // why the IPv6 tests skip, when they do
let P;
let P6;

const listen = (server, host) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });

before(async () => {
  v4 = http.createServer(routes(seen));
  P = await listen(v4, "127.0.0.1");
  v6 = http.createServer(routes(seen));
  try {
    P6 = await listen(v6, "::1");
  } catch (e) {
    v6Skip = `this machine cannot listen on [::1]: ${e.code ?? e.message}`;
    v6 = undefined;
  }
});

after(() => {
  for (const server of [v4, v6]) {
    if (!server) continue;
    server.closeAllConnections();
    server.close();
  }
});

const viaV4 = (path) => `http://127.0.0.1:${P}${path}`;
/** Only test names resolve: v6.example to ::1 alone. */
const resolve = async (host) => {
  if (host === "v6.example") return [{ address: "::1", family: 6 }];
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};

// --- Brotli and deflate ---------------------------------------------------------

test("Brotli: a page served Content-Encoding: br decodes to its text", async () => {
  const r = await f.safeFetch(viaV4("/br"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.kind, "html");
  assert.equal(r.html, "<p>Brotli décodé</p>");
  assert.match(seen.at(-1).headers["accept-encoding"], /\bbr\b/, "the request offers br");
});

test("deflate: a page served Content-Encoding: deflate decodes to its text", async () => {
  const r = await f.safeFetch(viaV4("/deflate"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.html, "<p>deflate décodé</p>");
  assert.match(seen.at(-1).headers["accept-encoding"], /\bdeflate\b/, "the request offers deflate");
});

test("deflate: a raw (RFC 1951) body without the zlib header decodes, as browsers do", async () => {
  const r = await f.safeFetch(viaV4("/deflate-raw"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.html, "<p>raw deflate décodé</p>");
});

test("deflate: a raw body whose first chunk is a single byte still decodes", async () => {
  const r = await f.safeFetch(viaV4("/deflate-raw-split"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.html, "<p>raw deflate in pieces</p>");
});

test("deflate: an empty body served Content-Encoding: deflate is an empty page", async () => {
  const r = await f.safeFetch(viaV4("/deflate-empty"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.html, "");
});

test("size cap: a Brotli body that decompresses past 5 MB is refused like gzip's", async () => {
  const r = await f.safeFetch(viaV4("/br-bomb"), { resolve });
  assert.deepEqual(r, { status: "failed", reason: "too-large", url: viaV4("/br-bomb") });
});

test("size cap: a deflate body that decompresses past 5 MB is refused", async () => {
  const r = await f.safeFetch(viaV4("/deflate-bomb"), { resolve });
  assert.deepEqual(r, { status: "failed", reason: "too-large", url: viaV4("/deflate-bomb") });
});

test("size cap: a raw deflate body that decompresses past 5 MB is refused", async () => {
  const r = await f.safeFetch(viaV4("/deflate-raw-bomb"), { resolve });
  assert.deepEqual(r, { status: "failed", reason: "too-large", url: viaV4("/deflate-raw-bomb") });
});

test("size cap: a Brotli body of exactly 5 MB decompressed is still fetched", async () => {
  const r = await f.safeFetch(viaV4("/br-exactly-5mb"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.html.length, 5 * MB);
});

// --- IPv6 ---------------------------------------------------------------------------

test("IPv6: a page on [::1], allowed by MNEMOS_FETCH_ALLOW_HOSTS, is fetched over IPv6", async (t) => {
  if (v6Skip) return t.skip(v6Skip);
  const url = `http://[::1]:${P6}/page`;
  const r = await f.safeFetch(url, { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.url, url, "after the https attempt, the http fallback");
  assert.equal(r.html, "<title>over IPv6</title>");
  assert.equal(seen.at(-1).remoteAddress, "::1");
  assert.equal(seen.at(-1).headers.host, `[::1]:${P6}`);
});

test("IPv6: a name resolving to ::1 alone is connected through that checked address", async (t) => {
  if (v6Skip) return t.skip(v6Skip);
  // v6.example is not in DNS anywhere: only the injected resolver's IPv6
  // answer reaches the server, which listens on [::1] and nowhere else.
  const url = `http://v6.example:${P6}/page`;
  const r = await f.safeFetch(url, { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.url, url);
  assert.equal(r.html, "<title>over IPv6</title>");
  assert.equal(seen.at(-1).remoteAddress, "::1");
  assert.equal(seen.at(-1).headers.host, `v6.example:${P6}`);
});

test("IPv6: without the allow list, [::1] is a private address and never requested", async (t) => {
  if (v6Skip) return t.skip(v6Skip);
  const before = seen.length;
  const url = `http://[::1]:${P6}/page`;
  const r = await f.safeFetch(url, { config: f.fetchConfig({}), resolve });
  assert.deepEqual(r, { status: "skipped", reason: "private-address", url });
  assert.equal(seen.length, before);
});
