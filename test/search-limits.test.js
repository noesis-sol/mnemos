// search_bookmarks edges: the no-match note without a folder filter, limit
// handling (zero, negative, the default of 100 and the cap of 200), query
// words holding regex characters, and result order. Tests that need more than
// the shared fixture write their own Bookmarks file into a temp directory.
// node:test runs each test file in its own process, so mutating process.env
// here cannot leak into other test files.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../dist/lib.js";

const { SEP } = lib;
const FIXTURE = fileURLToPath(new URL("./fixtures/bookmarks.json", import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-search-"));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const url = (name, href = `https://${encodeURIComponent(name)}.example/`) => ({
  type: "url",
  name,
  url: href,
});
const folder = (name, children) => ({ type: "folder", name, children });

let files = 0;
/** Write `roots` to a fresh Bookmarks file and point the library at it. */
function useRoots(roots) {
  const dir = path.join(TMP, String(files++));
  fs.mkdirSync(dir);
  const file = path.join(dir, "Bookmarks");
  fs.writeFileSync(file, JSON.stringify({ roots }));
  process.env.CHROME_BOOKMARKS_PATH = file;
}

/** 250 bookmarks that all match the query "widget". */
function useManyMatches() {
  const children = Array.from({ length: 250 }, (_, i) =>
    url(`Widget ${i}`, `https://widgets.example/${i}`),
  );
  useRoots({ bookmark_bar: folder("", children), other: folder("", []) });
}

// --- the no-match note -------------------------------------------------------

test("search: no match without a folder filter gives a plain note", () => {
  process.env.CHROME_BOOKMARKS_PATH = FIXTURE;
  const r = lib.searchBookmarks("zyxwvut");
  assert.equal(r.total_matches, 0);
  assert.deepEqual(r.matches, []);
  assert.equal(r.note, 'No bookmarks match "zyxwvut".');
  // The folder hint belongs only to a filtered search: here it would send the
  // caller looking for a folder name they never gave.
  assert.ok(!r.note.includes("list_folders"));
});

test("search: a blank folder filter counts as none in the no-match note", () => {
  process.env.CHROME_BOOKMARKS_PATH = FIXTURE;
  const r = lib.searchBookmarks("zyxwvut", "   ");
  assert.equal(r.note, 'No bookmarks match "zyxwvut".');
});

// --- limits ------------------------------------------------------------------

test("search: limit 0 returns no matches but the true total", () => {
  useManyMatches();
  const r = lib.searchBookmarks("widget", undefined, 0);
  assert.equal(r.total_matches, 250);
  assert.deepEqual(r.matches, []);
});

test("search: a negative limit returns no matches but the true total", () => {
  useManyMatches();
  const r = lib.searchBookmarks("widget", undefined, -3);
  assert.equal(r.total_matches, 250);
  assert.deepEqual(r.matches, []);
});

test("search: the default limit is 100", () => {
  useManyMatches();
  const r = lib.searchBookmarks("widget");
  assert.equal(r.total_matches, 250);
  assert.equal(r.matches.length, 100);
  assert.equal(r.matches[0].title, "Widget 0");
  assert.equal(r.matches[99].title, "Widget 99");
});

test("search: a limit above 200 is capped at 200", () => {
  useManyMatches();
  const r = lib.searchBookmarks("widget", undefined, 500);
  assert.equal(r.total_matches, 250);
  assert.equal(r.matches.length, 200);
  assert.equal(r.matches[199].title, "Widget 199");
});

// --- regex characters in a query word ------------------------------------------

test("search: regex characters in a query word match literally", () => {
  useRoots({
    bookmark_bar: folder("", [
      url("C++ reference", "https://en.cppreference.com/"),
      url("Ccc compiler", "https://ccc.example/"),
      url("Annual report (2024)", "https://reports.example/annual"),
      url("Annual report 2024", "https://reports.example/plain"),
      url("Budget 2024)", "https://reports.example/budget"),
    ]),
  });
  // Unescaped, "c++" is not a valid RegExp at all, and "(2024)" is a group
  // that would also match the titles without the parentheses.
  const cpp = lib.searchBookmarks("c++");
  assert.deepEqual(
    cpp.matches.map((m) => m.title),
    ["C++ reference"],
  );
  const year = lib.searchBookmarks("(2024)");
  assert.deepEqual(
    year.matches.map((m) => m.title),
    ["Annual report (2024)"],
  );
});

// --- order ---------------------------------------------------------------------

test("search: results come back in document order", () => {
  // Pre-order depth-first across the roots in file order: neither by title,
  // by date added, nor breadth-first.
  useRoots({
    bookmark_bar: folder("", [
      { ...url("Zeta topic"), date_added: "13349793600000000" },
      folder("A", [
        { ...url("Beta topic"), date_added: "13393252800000000" },
        folder("B", [{ ...url("Alpha topic"), date_added: "13300000000000000" }]),
      ]),
      { ...url("Gamma topic"), date_added: "13390000000000000" },
    ]),
    other: folder("", [{ ...url("Delta topic"), date_added: "13340000000000000" }]),
  });
  const r = lib.searchBookmarks("topic");
  assert.deepEqual(
    r.matches.map((m) => [m.title, m.folder]),
    [
      ["Zeta topic", "Bookmarks Bar"],
      ["Beta topic", `Bookmarks Bar${SEP}A`],
      ["Alpha topic", `Bookmarks Bar${SEP}A${SEP}B`],
      ["Gamma topic", "Bookmarks Bar"],
      ["Delta topic", "Other Bookmarks"],
    ],
  );
});

test("search: fixture results keep document order across roots", () => {
  process.env.CHROME_BOOKMARKS_PATH = FIXTURE;
  // The newest of the three ("GitHub repo two") comes last, as it does in the file.
  const r = lib.searchBookmarks("github");
  assert.deepEqual(
    r.matches.map((m) => m.title),
    ["Tesseract", "GitHub repo one", "GitHub repo two"],
  );
});
