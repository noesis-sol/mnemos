// The default page cap of PDF text extraction (src/pdf.ts: MAX_PDF_PAGES)
// on long PDFs built in memory by fixtures/make-pdf.js, read with the
// defaults: a 250-page PDF stops after page 200, a 200-page one is read
// whole, and the character cap (MAX_PDF_CHARS) still wins when it is
// reached first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as p from "../dist/pdf.js";
import { makePdf } from "./fixtures/make-pdf.js";

/** Page n's marker word: unique, and no marker is a prefix of another. */
const marker = (n) => `marker${String(n).padStart(3, "0")}x`;

/** The page numbers whose markers are in `text`, in order. */
const markersIn = (text) =>
  text
    .split(/\s+/)
    .map((word) => /^marker(\d{3})x$/.exec(word))
    .filter(Boolean)
    .map((m) => Number(m[1]));

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("a 250-page PDF read with the defaults has pages 1-200 and none after", async () => {
  const pdf = makePdf(range(1, 250).map((n) => [`page ${n}`, marker(n)]));
  const r = await p.extractPdfText(pdf);
  assert.equal(r.status, "ok");
  assert.equal(r.pages, 250);
  assert.equal(r.pagesRead, p.MAX_PDF_PAGES);
  assert.equal(r.truncated, true);
  assert.deepEqual(markersIn(r.text), range(1, 200));
  assert.equal(r.text.split("\n\n").length, 200);
  assert.ok(r.text.endsWith(`page 200 ${marker(200)}`));
});

test("a 200-page PDF read with the defaults is read whole", async () => {
  const pdf = makePdf(range(1, 200).map((n) => [`page ${n}`, marker(n)]));
  const r = await p.extractPdfText(pdf);
  assert.equal(r.status, "ok");
  assert.equal(r.pages, 200);
  assert.equal(r.pagesRead, 200);
  assert.equal(r.truncated, false);
  assert.deepEqual(markersIn(r.text), range(1, 200));
  assert.equal(r.text, range(1, 200).map((n) => `page ${n} ${marker(n)}`).join("\n\n"));
});

test("the default character cap stops a long PDF before the page cap does", async () => {
  // 250 pages of 1,210 characters: the 200,000-character cap is reached well
  // before page 200. Short lines, since pdf.js drops text past the page's edge.
  const lines = Array.from({ length: 20 }, () => "y".repeat(59));
  const pdf = makePdf(range(1, 250).map((n) => [marker(n), ...lines]));
  const pageLength = [marker(1), ...lines].join(" ").length;
  // extractPdfText counts each page's text plus its 2-character separator and
  // stops once the count reaches MAX_PDF_CHARS.
  const expectedPages = Math.ceil(p.MAX_PDF_CHARS / (pageLength + 2));
  assert.ok(expectedPages < p.MAX_PDF_PAGES, "the character cap is reached first");

  const r = await p.extractPdfText(pdf);
  assert.equal(r.status, "ok");
  assert.equal(r.pages, 250);
  assert.equal(r.pagesRead, expectedPages);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, p.MAX_PDF_CHARS, "the text is cut to the character cap");
  assert.deepEqual(markersIn(r.text), range(1, expectedPages));
  assert.equal(r.text.split("\n\n")[0], [marker(1), ...lines].join(" "));
});
