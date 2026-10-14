// recent_bookmarks when the browser stores no dates: Safari keeps a date added
// only for Reading List items, so its ordinary bookmarks come back in file
// order (Favorites first). A note must say so, or that order reads as what the
// user is focused on now. node:test runs each test file in its own process, so
// setting CHROME_BOOKMARKS_PATH here cannot leak into other test files.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../dist/lib.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
// The same tree twice: one Reading List item dated, and no dates at all.
const SAFARI_DATED = path.join(FIXTURES, "safari-bookmarks.plist");
const SAFARI_UNDATED = path.join(FIXTURES, "safari-bookmarks-undated.plist");
const CHROME = path.join(FIXTURES, "bookmarks.json");

test("recent: Safari with no dates says the list is in file order, not newest first", () => {
  process.env.CHROME_BOOKMARKS_PATH = SAFARI_UNDATED;
  const r = lib.recentBookmarks();
  assert.equal(r.total_matches, 7);
  assert.ok(r.bookmarks.every((b) => b.added === null));
  // File order, Favorites first: what the note warns about.
  assert.deepEqual(
    r.bookmarks.map((b) => b.title),
    ["Apple", "Βικιπαίδεια", "MDN Web Docs", "Sourdough", "Tidepools", "Undated", "Loose bookmark"],
  );
  assert.match(r.note, /stores no date added for these bookmarks/);
  assert.match(r.note, /file's order, not newest first/);
});

test("recent: the no-dates note holds for a truncated list too", () => {
  process.env.CHROME_BOOKMARKS_PATH = SAFARI_UNDATED;
  const r = lib.recentBookmarks(2);
  assert.equal(r.total_matches, 7);
  assert.equal(r.bookmarks.length, 2);
  assert.match(r.note, /stores no date added/);
});

test("recent: when only some returned bookmarks are dated, the note counts them", () => {
  process.env.CHROME_BOOKMARKS_PATH = SAFARI_DATED;
  const r = lib.recentBookmarks();
  assert.equal(r.bookmarks[0].title, "Tidepools");
  assert.equal(r.bookmarks[0].added, "2024-05-01");
  assert.equal(
    r.note,
    "Only 1 of these 7 bookmarks has a date added; the rest (added: null) follow in " +
      "the bookmarks file's order, not by recency.",
  );
});

test("recent: no note when every returned bookmark has a date", () => {
  process.env.CHROME_BOOKMARKS_PATH = SAFARI_DATED;
  const r = lib.recentBookmarks(1);
  assert.equal(r.bookmarks[0].title, "Tidepools");
  assert.ok(!("note" in r));

  process.env.CHROME_BOOKMARKS_PATH = CHROME;
  assert.ok(!("note" in lib.recentBookmarks(3)));
});
