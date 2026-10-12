// recent_bookmarks edges: a bookmark with no date_added, bookmarks sharing a
// timestamp, limit handling (the default of 100 and the cap of 200), and dates
// rendered in the machine's local timezone. Each test writes its own Bookmarks
// file into a temp directory. node:test runs each test file in its own
// process, so mutating process.env (CHROME_BOOKMARKS_PATH, TZ) here cannot
// leak into other test files.
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-recent-"));
const ORIGINAL_TZ = process.env.TZ;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** Chrome's date_added for an ISO instant: microseconds since 1601-01-01 UTC. */
const chromeTime = (iso) => String((new Date(iso).getTime() + 11_644_473_600_000) * 1000);

const url = (name, date_added) => ({
  type: "url",
  name,
  url: `https://${encodeURIComponent(name)}.example/`,
  ...(date_added === undefined ? {} : { date_added }),
});
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

// --- missing date_added ------------------------------------------------------

test("recent: a bookmark with no date_added sorts after every dated one with added: null", () => {
  // Undated first in document order, so only the sort can move it to the end.
  useBookmarks([
    url("Undated"),
    url("Old", chromeTime("2001-03-04T12:00:00Z")),
    url("New", chromeTime("2024-05-06T12:00:00Z")),
  ]);
  const r = lib.recentBookmarks();
  assert.equal(r.total_matches, 3);
  assert.deepEqual(
    r.bookmarks.map((b) => [b.title, b.added]),
    [
      ["New", "2024-05-06"],
      ["Old", "2001-03-04"],
      ["Undated", null],
    ],
  );
});

// --- ties --------------------------------------------------------------------

test("recent: bookmarks sharing a timestamp keep document order", () => {
  const same = chromeTime("2024-05-06T12:00:00Z");
  const tied = Array.from({ length: 30 }, (_, i) => url(`Tie ${i}`, same));
  // An older and a newer bookmark at each end, so the sort has work to do.
  useBookmarks([
    url("Older", chromeTime("2020-01-01T12:00:00Z")),
    ...tied,
    url("Newer", chromeTime("2025-01-01T12:00:00Z")),
  ]);
  const r = lib.recentBookmarks(200);
  assert.deepEqual(
    r.bookmarks.map((b) => b.title),
    ["Newer", ...tied.map((b) => b.name), "Older"],
  );
});

// --- limits ------------------------------------------------------------------

/** 250 bookmarks, "Item 0" oldest to "Item 249" newest, one day apart. */
function useManyBookmarks() {
  const start = Date.parse("2020-01-01T12:00:00Z");
  useBookmarks(
    Array.from({ length: 250 }, (_, i) =>
      url(`Item ${i}`, chromeTime(new Date(start + i * 86_400_000).toISOString())),
    ),
  );
}

test("recent: the default limit returns the 100 newest with the true total", () => {
  useManyBookmarks();
  const r = lib.recentBookmarks();
  assert.equal(r.total_matches, 250);
  assert.equal(r.bookmarks.length, 100);
  assert.equal(r.bookmarks[0].title, "Item 249");
  assert.equal(r.bookmarks[99].title, "Item 150");
});

test("recent: a limit over the cap returns 200 with the true total", () => {
  useManyBookmarks();
  const r = lib.recentBookmarks(500);
  assert.equal(r.total_matches, 250);
  assert.equal(r.bookmarks.length, 200);
  assert.equal(r.bookmarks[0].title, "Item 249");
  assert.equal(r.bookmarks[199].title, "Item 50");
});

// --- local timezone ----------------------------------------------------------

// 23:30 UTC on 15 January is 08:30 on 16 January in Tokyo (UTC+9, no DST).
const LATE_UTC = chromeTime("2024-01-15T23:30:00Z");

test("recent: a 23:30 UTC timestamp renders as the next day under TZ=Asia/Tokyo", () => {
  process.env.TZ = "Asia/Tokyo";
  assert.equal(lib.chromeTimeToIso(LATE_UTC), "2024-01-16");
  useBookmarks([url("Late", LATE_UTC)]);
  assert.equal(lib.recentBookmarks().bookmarks[0].added, "2024-01-16");
});

test("recent: a 23:30 UTC timestamp renders as the same day under TZ=UTC", () => {
  process.env.TZ = "UTC";
  assert.equal(lib.chromeTimeToIso(LATE_UTC), "2024-01-15");
  useBookmarks([url("Late", LATE_UTC)]);
  assert.equal(lib.recentBookmarks().bookmarks[0].added, "2024-01-15");
});
