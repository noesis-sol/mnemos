// safeFetch on PDFs, against a local node:http server on 127.0.0.1 let
// through by MNEMOS_FETCH_ALLOW_HOSTS: application/pdf comes back as bytes,
// a generic download type only for a .pdf path, the header is checked, the
// size cap holds, acceptPdf: false skips PDFs, and the bytes extract to text.
// Only test names resolve, so nothing here can reach the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import * as f from "../dist/fetch.js";
import { extractPdfText } from "../dist/pdf.js";
import { makePdf } from "./fixtures/make-pdf.js";

process.env.MNEMOS_FETCH_ALLOW_HOSTS = "127.0.0.1";

const MB = 1024 * 1024;
const PDF = Buffer.from(makePdf([["A bookmarked paper", "on local embeddings"], ["Second page"]]));

const seen = [];
let server;
let P;

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const send = (type, body, headers = {}) => {
      res.writeHead(200, { "Content-Type": type, ...headers });
      res.end(body);
    };
    switch (new URL(req.url, "http://x").pathname) {
      case "/paper":
        return send("application/pdf", PDF);
      case "/x-pdf":
        return send("application/x-pdf; name=paper.pdf", PDF);
      case "/files/paper.PDF":
        return send("application/octet-stream", PDF);
      case "/files/paper":
        return send("application/octet-stream", PDF);
      case "/gzip-paper":
        return send("application/pdf", zlib.gzipSync(PDF), { "Content-Encoding": "gzip" });
      case "/login.pdf":
        return send("application/pdf", "<!doctype html><form><input type=password></form>");
      case "/big.pdf":
        return send("application/pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5 * MB, 0x20)]));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  P = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const at = (path) => `http://127.0.0.1:${P}${path}`;
const resolve = async (host) => {
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};

test("application/pdf comes back as the file's bytes, with kind pdf", async () => {
  const r = await f.safeFetch(at("/paper"), { resolve });
  assert.equal(r.status, "ok");
  assert.equal(r.kind, "pdf");
  assert.equal(r.url, at("/paper"));
  assert.equal(r.httpStatus, 200);
  assert.equal(r.contentType, "application/pdf");
  assert.deepEqual(Buffer.from(r.pdf), PDF);
  assert.equal("html" in r, false);
});

test("application/x-pdf, and a gzip-encoded PDF, are taken too", async () => {
  const x = await f.safeFetch(at("/x-pdf"), { resolve });
  assert.equal(x.kind, "pdf");
  assert.equal(x.contentType, "application/pdf");
  const gz = await f.safeFetch(at("/gzip-paper"), { resolve });
  assert.equal(gz.kind, "pdf");
  assert.deepEqual(Buffer.from(gz.pdf), PDF);
});

test("application/octet-stream is a PDF only at a path ending in .pdf", async () => {
  const named = await f.safeFetch(at("/files/paper.PDF"), { resolve });
  assert.equal(named.kind, "pdf");
  assert.deepEqual(await f.safeFetch(at("/files/paper"), { resolve }), {
    status: "skipped",
    reason: "not-html",
    url: at("/files/paper"),
  });
});

test("a body without the %PDF- header is not taken for a PDF", async () => {
  assert.deepEqual(await f.safeFetch(at("/login.pdf"), { resolve }), {
    status: "skipped",
    reason: "not-html",
    url: at("/login.pdf"),
  });
});

test("the 5 MB cap holds for PDFs", async () => {
  assert.deepEqual(await f.safeFetch(at("/big.pdf"), { resolve }), {
    status: "failed",
    reason: "too-large",
    url: at("/big.pdf"),
  });
});

test("Accept names application/pdf, unless acceptPdf is false", async () => {
  await f.safeFetch(at("/paper"), { resolve });
  assert.match(seen.at(-1).headers.accept, /application\/pdf/);
  await f.safeFetch(at("/paper"), { resolve, acceptPdf: false });
  assert.doesNotMatch(seen.at(-1).headers.accept, /application\/pdf/);
  assert.match(seen.at(-1).headers.accept, /text\/html/);
});

test("a fetched PDF extracts to its text", async () => {
  const r = await f.safeFetch(at("/paper"), { resolve });
  const text = await extractPdfText(r.pdf);
  assert.equal(text.status, "ok");
  assert.equal(text.text, "A bookmarked paper on local embeddings\n\nSecond page");
});
