// The encoding of a fetched page, found as a browser finds it: a byte order
// mark, else the Content-Type header's charset, else a <meta> in the first
// 1024 bytes, else UTF-8. safeFetch against a local node:http server on
// 127.0.0.1 (let through by MNEMOS_FETCH_ALLOW_HOSTS), and the sniffing in
// charset.js on its own.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as f from "../dist/fetch.js";
import * as c from "../dist/charset.js";

process.env.MNEMOS_FETCH_ALLOW_HOSTS = "127.0.0.1";

const TEXT = "Crème brûlée – naïve";
/** windows-1252 bytes of TEXT: è û é – ï are one byte each, the dash 0x96. */
const cp1252 = (s) =>
  Buffer.from([...s].map((ch) => (ch === "–" ? 0x96 : ch.charCodeAt(0))));
const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const utf16be = (s) => {
  const le = Buffer.from(s, "utf16le");
  for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
};
const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
// "日本語" in Shift_JIS.
const SJIS = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

const pages = {
  // The ticket's probe: no charset in the header, windows-1252 bytes, <meta charset>.
  "/meta-charset": ["text/html", Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>'), cp1252(TEXT), Buffer.from("</p>")])],
  "/meta-http-equiv": [
    "text/html",
    Buffer.concat([
      Buffer.from('<html><head><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=Shift_JIS"></head><p>'),
      SJIS,
    ]),
  ],
  "/header-wins": [
    "text/html; charset=utf-8",
    Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>'), Buffer.from(TEXT)]),
  ],
  "/bom-wins": [
    "text/html; charset=windows-1252",
    Buffer.concat([BOM8, Buffer.from('<meta charset="shift_jis"><p>'), Buffer.from(TEXT)]),
  ],
  "/utf16le": ["text/html", utf16le(`<meta charset="utf-16"><p>${TEXT}`)],
  "/utf16be": ["text/html; charset=windows-1252", utf16be(`<p>${TEXT}`)],
  "/no-declaration": ["text/html", Buffer.from(`<p>${TEXT}`)],
};

let server;
let P;

before(async () => {
  server = http.createServer((req, res) => {
    const page = pages[req.url];
    if (!page) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": page[0] }).end(page[1]);
  });
  P = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const get = (path) => f.safeFetch(`http://127.0.0.1:${P}${path}`, { upgradeConnectTimeoutMs: 1_000 });

// --- safeFetch -------------------------------------------------------------

test("a page that declares windows-1252 only in <meta charset> decodes, and says so", async () => {
  const r = await get("/meta-charset");
  assert.equal(r.status, "ok");
  assert.equal(r.html, `<meta charset="windows-1252"><p>${TEXT}</p>`);
  assert.equal(r.charset, "windows-1252");
});

test('a <meta http-equiv="Content-Type"> charset is taken too', async () => {
  const r = await get("/meta-http-equiv");
  assert.equal(r.status, "ok");
  assert.ok(r.html.endsWith("<p>日本語"), r.html);
  assert.equal(r.charset, "shift_jis");
});

test("the header's charset wins over <meta>", async () => {
  const r = await get("/header-wins");
  assert.ok(r.html.endsWith(`<p>${TEXT}`), r.html);
  assert.equal(r.charset, "utf-8");
});

test("a byte order mark wins over the header and <meta>, and is dropped", async () => {
  const r = await get("/bom-wins");
  assert.equal(r.html, `<meta charset="shift_jis"><p>${TEXT}`);
  assert.equal(r.charset, "utf-8");
});

test("a UTF-16 page with a byte order mark decodes, little- or big-endian", async () => {
  const le = await get("/utf16le");
  assert.equal(le.html, `<meta charset="utf-16"><p>${TEXT}`);
  assert.equal(le.charset, "utf-16le");
  const be = await get("/utf16be");
  assert.equal(be.html, `<p>${TEXT}`);
  assert.equal(be.charset, "utf-16be");
});

test("with no declaration anywhere, a page is UTF-8", async () => {
  const r = await get("/no-declaration");
  assert.equal(r.html, `<p>${TEXT}`);
  assert.equal(r.charset, "utf-8");
});

// --- the sniffing on its own -----------------------------------------------

const scan = (s) => c.prescanMetaCharset(Buffer.from(s, "latin1"));

test("prescan: <meta charset> in its spellings", () => {
  assert.equal(scan('<meta charset="windows-1252">'), "windows-1252");
  assert.equal(scan("<meta charset='ISO-8859-7'>"), "iso-8859-7");
  assert.equal(scan("<META CHARSET=koi8-r>"), "koi8-r");
  assert.equal(scan("<meta\tcharset = gb2312 />"), "gbk");
  assert.equal(scan('<meta/charset="euc-jp">'), "euc-jp");
  assert.equal(scan('<meta name="viewport" content="width=device-width"><meta charset="big5">'), "big5");
});

test("prescan: http-equiv needs both the pragma and a charset in content, in either order", () => {
  assert.equal(scan('<meta content="text/html; charset=windows-1251" http-equiv="content-type">'), "windows-1251");
  assert.equal(scan('<meta http-equiv="Content-Type" content="text/html;charset=\'euc-kr\'">'), "euc-kr");
  assert.equal(scan('<meta content="text/html; charset=windows-1251">'), null, "no http-equiv");
  assert.equal(scan('<meta http-equiv="refresh" content="0; charset=windows-1251">'), null, "another pragma");
});

test("prescan: a charset in a comment, another tag's attribute or past 1024 bytes is not taken", () => {
  assert.equal(scan('<!-- <meta charset="windows-1252"> --><p>'), null);
  assert.equal(scan('<!--><meta charset="windows-1252">'), "windows-1252", "<!--> is an empty comment");
  assert.equal(scan('<div title="<meta charset=windows-1252>">'), null);
  assert.equal(scan(`${" ".repeat(c.PRESCAN_BYTES)}<meta charset="windows-1252">`), null);
  assert.equal(scan('<metadata charset="windows-1252">'), null, "not a meta element");
});

test("prescan: unknown labels are skipped; UTF-16 means UTF-8; x-user-defined means windows-1252", () => {
  assert.equal(scan('<meta charset="no-such-thing"><meta charset="koi8-u">'), "koi8-u");
  assert.equal(scan('<meta charset="utf-16le">'), "utf-8");
  assert.equal(scan('<meta charset="x-user-defined">'), "windows-1252");
  assert.equal(scan('<meta charset="iso-2022-kr">'), null, "the replacement encoding");
});

test("prescan: the first charset attribute of a meta counts", () => {
  assert.equal(scan('<meta charset="koi8-r" charset="utf-8">'), "koi8-r");
});

test("decodeHtml: an unknown header charset falls through to <meta>", () => {
  const body = Buffer.concat([Buffer.from('<meta charset="windows-1252">'), cp1252(TEXT)]);
  assert.deepEqual(c.decodeHtml(body, "no-such-thing"), {
    html: `<meta charset="windows-1252">${TEXT}`,
    charset: "windows-1252",
  });
  assert.equal(c.decodeHtml(body, "ISO-8859-1").charset, "windows-1252", "labels map as in a browser");
  assert.equal(c.decodeHtml(Buffer.alloc(0)).charset, "utf-8");
});

test("charsetFromContent", () => {
  assert.equal(c.charsetFromContent("text/html; charset=Shift_JIS"), "Shift_JIS");
  assert.equal(c.charsetFromContent('text/html; charset = "big5"; x'), "big5");
  assert.equal(c.charsetFromContent("text/html; charsetx; charset=utf-8;"), "utf-8");
  assert.equal(c.charsetFromContent('charset="unterminated'), null);
  assert.equal(c.charsetFromContent("text/html"), null);
});
