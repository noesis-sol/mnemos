// Unit tests for the pure logic in lib.ts. Every named case that references a
// "regression" is a bug that actually shipped at some point — keep them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderMatches, chromeTimeToIso, chromeBase, bookmarksPath, cap, SEP } from "../dist/lib.js";

// --- folderMatches ---------------------------------------------------------

test("folderMatches: plain ASCII match", () => {
  assert.equal(folderMatches(`Bookmarks Bar${SEP}AI`, "AI"), true);
});

test("folderMatches: case-insensitive", () => {
  assert.equal(folderMatches(`Bookmarks Bar${SEP}AI`, "ai"), true);
});

test("folderMatches: matches ancestors, so subfolder contents are included", () => {
  assert.equal(folderMatches(`Other${SEP}GEN AI${SEP}Agents`, "gen ai"), true);
});

test("folderMatches regression: 'ai' must not match inside 'Painting'", () => {
  assert.equal(folderMatches(`Bookmarks Bar${SEP}Painting`, "ai"), false);
});

test("folderMatches regression: Greek needle matches Greek folder (JS \\b is ASCII-only)", () => {
  assert.equal(folderMatches(`Bookmarks Bar${SEP}Ελληνική`, "Ελληνική"), true);
  assert.equal(folderMatches(`Other${SEP}Ταξίδια 2024`, "ταξίδια"), true);
});

test("folderMatches regression: folder name containing '/' is one segment", () => {
  assert.equal(folderMatches(`Apps${SEP}Vision / OCR`, "Vision / OCR"), true);
  assert.equal(folderMatches(`Apps${SEP}Vision / OCR`, "OCR"), true);
});

test("folderMatches: regex special characters in needle are literal", () => {
  assert.equal(folderMatches(`Dev${SEP}C++ stuff`, "c++"), true);
  assert.equal(folderMatches(`Dev${SEP}Notes (2024)`, "(2024)"), true);
});

test("folderMatches: empty/whitespace needle matches everything", () => {
  assert.equal(folderMatches(`Anything`, "   "), true);
});

// --- chromeTimeToIso -------------------------------------------------------

test("chromeTimeToIso: valid noon-UTC timestamp renders the expected date", () => {
  // 13349793600000000 µs = 2024-01-15T12:00:00Z; noon UTC keeps the same
  // calendar date in every timezone from UTC-12 to UTC+11:59.
  assert.equal(chromeTimeToIso("13349793600000000"), "2024-01-15");
});

test("chromeTimeToIso regression: out-of-range value returns null, never throws", () => {
  assert.equal(chromeTimeToIso("99999999999999999999"), null);
});

test("chromeTimeToIso: zero, negative, missing, and garbage all return null", () => {
  assert.equal(chromeTimeToIso("0"), null);
  assert.equal(chromeTimeToIso("-5"), null);
  assert.equal(chromeTimeToIso(undefined), null);
  assert.equal(chromeTimeToIso("not-a-number"), null);
});

// --- chromeBase / bookmarksPath -------------------------------------------

test("chromeBase: macOS path", () => {
  assert.match(chromeBase("darwin", {}), /Library\/Application Support\/Google\/Chrome$/);
});

test("chromeBase: Windows honors LOCALAPPDATA", () => {
  const base = chromeBase("win32", { LOCALAPPDATA: "/tmp/appdata" });
  assert.match(base.replaceAll("\\", "/"), /\/tmp\/appdata\/Google\/Chrome\/User Data$/);
});

test("chromeBase: Linux honors XDG_CONFIG_HOME, defaults to ~/.config", () => {
  assert.match(chromeBase("linux", { XDG_CONFIG_HOME: "/tmp/xdg" }).replaceAll("\\", "/"), /\/tmp\/xdg\/google-chrome$/);
  assert.match(chromeBase("linux", {}).replaceAll("\\", "/"), /\.config\/google-chrome$/);
});

test("bookmarksPath: CHROME_BOOKMARKS_PATH overrides everything", () => {
  assert.equal(bookmarksPath({ CHROME_BOOKMARKS_PATH: "/x/Bookmarks", CHROME_PROFILE: "P" }), "/x/Bookmarks");
});

test("bookmarksPath regression: empty CHROME_PROFILE falls back to Default", () => {
  const p = bookmarksPath({ CHROME_PROFILE: "" }, "darwin").replaceAll("\\", "/");
  assert.match(p, /\/Default\/Bookmarks$/);
});

// --- cap -------------------------------------------------------------------

test("cap: default, ceiling, and floor", () => {
  assert.equal(cap(undefined, 100), 100);
  assert.equal(cap(500, 100), 200);
  assert.equal(cap(0, 100), 1);
  assert.equal(cap(-5, 100), 1);
});
