// PDF text extraction (src/pdf.ts) through the real unpdf optional
// dependency, on PDFs built in memory by fixtures/make-pdf.js: text and page
// structure, the page and character caps, encrypted and broken files, a
// missing parser, an abort, and silence on stdout and stderr (stdout is the
// MCP channel).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "../dist/pdf.js";
import { makePdf } from "./fixtures/make-pdf.js";

const run = promisify(execFile);

test("pdfSupport: unpdf is installed, so PDFs can be read", async () => {
  assert.deepEqual(await p.pdfSupport(), { available: true });
});

test("text: lines joined by spaces, whitespace collapsed, pages separated by a blank line", async () => {
  const pdf = makePdf([
    ["Bookmarks worth (keeping)", "second    line"],
    [],
    ["Page three", "café au lait"],
  ]);
  const r = await p.extractPdfText(pdf);
  assert.deepEqual(r, {
    status: "ok",
    text: "Bookmarks worth (keeping) second line\n\nPage three café au lait",
    pages: 3,
    pagesRead: 3,
    truncated: false,
  });
});

test("a Buffer is accepted and left untouched", async () => {
  const bytes = Buffer.from(makePdf([["from a buffer"]]));
  const copy = Buffer.from(bytes);
  const r = await p.extractPdfText(bytes);
  assert.equal(r.text, "from a buffer");
  assert.deepEqual(bytes, copy);
});

test("a PDF with no text (a scan) is ok with empty text", async () => {
  const r = await p.extractPdfText(makePdf([[], []]));
  assert.deepEqual(r, { status: "ok", text: "", pages: 2, pagesRead: 2, truncated: false });
});

test("maxPages stops after that many pages and says the text is truncated", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => [`page ${i + 1}`]);
  const r = await p.extractPdfText(makePdf(pages), { maxPages: 2 });
  assert.deepEqual(r, { status: "ok", text: "page 1\n\npage 2", pages: 5, pagesRead: 2, truncated: true });
});

test("maxChars stops reading pages once reached and cuts the text to it", async () => {
  const pages = Array.from({ length: 4 }, () => ["x".repeat(30)]);
  const r = await p.extractPdfText(makePdf(pages), { maxChars: 40 });
  assert.equal(r.status, "ok");
  assert.equal(r.text, `${"x".repeat(30)}\n\n${"x".repeat(8)}`);
  assert.equal(r.pagesRead, 2, "the third and fourth pages are not read");
  assert.equal(r.truncated, true);
});

test("the defaults are 200 pages and 200,000 characters", () => {
  assert.equal(p.MAX_PDF_PAGES, 200);
  assert.equal(p.MAX_PDF_CHARS, 200_000);
});

test("an encrypted PDF fails as encrypted", async () => {
  assert.deepEqual(await p.extractPdfText(makePdf([["secret"]], { encrypt: true })), {
    status: "failed",
    reason: "encrypted",
  });
});

test("bytes that are not a PDF fail as invalid", async () => {
  const r = await p.extractPdfText(new TextEncoder().encode("<html>not a pdf</html>"));
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "invalid");
});

test("a broken cross-reference table is recovered from", async () => {
  const r = await p.extractPdfText(makePdf([["still readable"]], { brokenXref: true }));
  assert.equal(r.status, "ok");
  assert.equal(r.text, "still readable");
});

test("an aborted signal stops extraction", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await p.extractPdfText(makePdf([["never read"]]), { signal: controller.signal }), {
    status: "failed",
    reason: "aborted",
  });
});

test("an abort during extraction stops it", async () => {
  const controller = new AbortController();
  const pages = Array.from({ length: 50 }, (_, i) => [`page ${i + 1}`]);
  const extraction = p.extractPdfText(makePdf(pages), { signal: controller.signal });
  setImmediate(() => controller.abort());
  assert.deepEqual(await extraction, { status: "failed", reason: "aborted" });
});

test("a parser that does not load makes extraction unavailable, not an error", async () => {
  const load = () => Promise.reject(new Error("Cannot find package 'unpdf'"));
  const r = await p.extractPdfText(makePdf([["x"]]), { load });
  assert.equal(r.status, "unavailable");
  assert.match(r.reason, /Cannot find package 'unpdf'/);
  const support = await p.pdfSupport(load);
  assert.equal(support.available, false);
  assert.match(support.reason, /Cannot find package 'unpdf'/);
});

test("looksLikePdf: the %PDF- header within the first 1024 bytes", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(p.looksLikePdf(enc("%PDF-1.7\n")), true);
  assert.equal(p.looksLikePdf(enc(`${" ".repeat(1000)}%PDF-1.4`)), true);
  assert.equal(p.looksLikePdf(enc(`${" ".repeat(1020)}%PDF-1.4`)), false);
  assert.equal(p.looksLikePdf(enc("<!doctype html>")), false);
  assert.equal(p.looksLikePdf(new Uint8Array(0)), false);
});

test("pdf.js writes nothing to stdout or stderr, even for a broken file", async () => {
  // In a child process, so the output streams are the ones under test.
  const script = `
    import { extractPdfText } from ${JSON.stringify(new URL("../dist/pdf.js", import.meta.url).href)};
    import { makePdf } from ${JSON.stringify(new URL("./fixtures/make-pdf.js", import.meta.url).href)};
    const results = [
      await extractPdfText(makePdf([["recovered"]], { brokenXref: true })),
      await extractPdfText(new TextEncoder().encode("garbage")),
      await extractPdfText(makePdf([["locked"]], { encrypt: true })),
    ];
    if (results.map((r) => r.status).join() !== "ok,failed,failed") process.exit(3);
  `;
  const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", script]);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});
