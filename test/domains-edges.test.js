// top_domains edges: domains ordered by bookmark count, limit handling (the
// default of 25 and the cap of 100), non-web and unparseable URLs skipped,
// http: and https: counted as one host, and subdomains kept apart. Each test
// writes its own Bookmarks file into a temp directory. node:test runs each test
// file in its own process, so setting CHROME_BOOKMARKS_PATH here cannot leak
// into other test files.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-domains-"));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const url = (href, name = href) => ({ type: "url", name, url: href });
const folder = (name, children) => ({ type: "folder", name, children });

let files = 0;
/** Write `children` as the bookmark bar of a fresh Bookmarks file and point the library at it. */
function useBookmarks(children) {
  const dir = path.join(TMP, String(files++));
  fs.mkdirSync(dir);
  const file = path.join(dir, "Bookmarks");
  const roots = { bookmark_bar: folder("", children), other: folder("", []) };
  fs.writeFileSync(file, JSON.stringify({ roots }));
  process.env.CHROME_BOOKMARKS_PATH = file;
}

/** `n` bookmarks on `host`, each a distinct page. */
const pages = (host, n) => Array.from({ length: n }, (_, i) => url(`https://${host}/page-${i}`));

// --- ordering ----------------------------------------------------------------

test("top_domains: domains are ordered by count, highest first", () => {
  // Fewest first in document order, so only the sort can put the most first.
  useBookmarks([
    ...pages("one.example", 1),
    folder("Nested", [...pages("three.example", 3)]),
    ...pages("two.example", 2),
    ...pages("four.example", 4),
  ]);
  const r = lib.topDomains();
  assert.equal(r.total_matches, 4);
  assert.deepEqual(r.domains, [
    { domain: "four.example", bookmarks: 4 },
    { domain: "three.example", bookmarks: 3 },
    { domain: "two.example", bookmarks: 2 },
    { domain: "one.example", bookmarks: 1 },
  ]);
});

// --- limits ------------------------------------------------------------------

/** 120 distinct domains; "d0.example" has 120 bookmarks, down to "d119.example" with 1. */
function useManyDomains() {
  const bookmarks = [];
  // Least-bookmarked domain first, so the order the test sees comes from the sort.
  for (let i = 119; i >= 0; i--) bookmarks.push(...pages(`d${i}.example`, 120 - i));
  useBookmarks(bookmarks);
}
const firstDomains = (n) => Array.from({ length: n }, (_, i) => `d${i}.example`);

test("top_domains: the default limit is 25, with total_matches counting every domain", () => {
  useManyDomains();
  const r = lib.topDomains();
  assert.equal(r.total_matches, 120);
  assert.deepEqual(
    r.domains.map((d) => d.domain),
    firstDomains(25),
  );
  assert.equal(r.domains[0].bookmarks, 120);
  assert.equal(r.domains[24].bookmarks, 96);
});

test("top_domains: a limit above 100 is capped at 100", () => {
  useManyDomains();
  for (const limit of [101, 120, 1000]) {
    const r = lib.topDomains(limit);
    assert.equal(r.total_matches, 120, `limit ${limit}`);
    assert.deepEqual(
      r.domains.map((d) => d.domain),
      firstDomains(100),
      `limit ${limit}`,
    );
  }
});

test("top_domains: a limit under the cap is honoured", () => {
  useManyDomains();
  const r = lib.topDomains(7);
  assert.equal(r.total_matches, 120);
  assert.deepEqual(
    r.domains.map((d) => d.domain),
    firstDomains(7),
  );
});

// --- URL filtering -----------------------------------------------------------

test("top_domains: file:// and unparseable URLs are skipped", () => {
  useBookmarks([
    url("file:///Users/me/notes.html"),
    url("file://server/share/doc.pdf"),
    url("not a url"),
    url(""),
    { type: "url", name: "No url field" },
    url("https://kept.example/"),
  ]);
  const r = lib.topDomains();
  assert.equal(r.total_matches, 1);
  assert.deepEqual(r.domains, [{ domain: "kept.example", bookmarks: 1 }]);
});

test("top_domains: http: and https: on the same host count as one domain", () => {
  useBookmarks([
    url("http://mixed.example/a"),
    url("https://mixed.example/b"),
    url("http://mixed.example:8080/c"),
    url("https://other.example/"),
  ]);
  const r = lib.topDomains();
  assert.equal(r.total_matches, 2);
  assert.deepEqual(r.domains, [
    { domain: "mixed.example", bookmarks: 3 },
    { domain: "other.example", bookmarks: 1 },
  ]);
});

test("top_domains: subdomains are kept apart from their parent domain", () => {
  useBookmarks([
    url("https://docs.anthropic.com/en/docs"),
    url("https://docs.anthropic.com/en/api"),
    url("https://anthropic.com/news"),
    url("https://www.anthropic.com/research"), // www. folds into the parent
    url("https://anthropic.com/company"),
  ]);
  const r = lib.topDomains();
  assert.equal(r.total_matches, 2);
  assert.deepEqual(r.domains, [
    { domain: "anthropic.com", bookmarks: 3 },
    { domain: "docs.anthropic.com", bookmarks: 2 },
  ]);
});
