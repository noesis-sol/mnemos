// Unit tests for the pure logic in lib.ts. Every named case that references a
// "regression" is a bug that actually shipped at some point — keep them.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  folderMatches,
  queryMatches,
  chromeTimeToIso,
  chromeBase,
  bookmarksPath,
  cap,
  MAX_CLOCK_SKEW_MS,
  SEP,
} from "../dist/lib.js";

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

test("folderMatches regression: a folder literally named 'A › B' is reachable", () => {
  // It renders identically to B nested inside A, so the joined path has to be
  // a match candidate too — otherwise list_folders shows a folder that
  // list_folder_contents cannot open.
  assert.equal(folderMatches(`Bookmarks Bar${SEP}A ${SEP.trim()} B`, `A ${SEP.trim()} B`), true);
  assert.equal(folderMatches(`Bookmarks Bar${SEP}A${SEP}B`, `A${SEP}B`), true);
  // The separator being matchable must not weaken segment precision.
  assert.equal(folderMatches(`Bookmarks Bar${SEP}Painting`, "ai"), false);
});

// --- queryMatches ----------------------------------------------------------

test("queryMatches regression: short words do not match mid-word", () => {
  // Plain substring matching made search_bookmarks("ai") return Gmail and
  // Painting — exactly the false positives folderMatches was built to avoid.
  assert.equal(queryMatches("gmail https://mail.google.com/", "ai"), false);
  assert.equal(queryMatches("watercolor basics › painting", "ai"), false);
});

test("queryMatches: matches at a word start, including prefixes", () => {
  assert.equal(queryMatches("kubernetes the hard way", "kubernet"), true);
  assert.equal(queryMatches("anthropic docs https://docs.anthropic.com/", "docs"), true);
  assert.equal(queryMatches("openai https://openai.com/", "openai"), true);
  // Punctuation and separators start a word, so URL components stay findable.
  assert.equal(queryMatches("https://docs.anthropic.com/en/api", "api"), true);
});

test("queryMatches: Unicode word starts (JS \\b is ASCII-only)", () => {
  assert.equal(queryMatches("καβάφης — ποιήματα", "ποιήμ"), true);
  assert.equal(queryMatches("καβάφης — ποιήματα", "οιήμ"), false);
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

/** Microseconds since 1601-01-01 UTC, the format Chrome stores. */
const chromeTime = (iso) => String((new Date(iso).getTime() + 11_644_473_600_000) * 1000);

test("chromeTimeToIso regression: a plausible future date is rejected, not just an impossible one", () => {
  // The old guard only caught values outside the JS Date range (~year 275760).
  // A year-3000 date_added — what a bad import or a skewed clock actually
  // produces — was a perfectly valid Date and sorted to the top of
  // recent_bookmarks forever.
  assert.equal(chromeTimeToIso(chromeTime("3000-01-01T00:00:00Z")), null);
  assert.equal(chromeTimeToIso(chromeTime("2199-06-15T00:00:00Z")), null);
});

test("chromeTimeToIso: dates up to the skew allowance still render", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  // Noon UTC keeps the same calendar date from UTC-12 to UTC+11:59.
  assert.equal(chromeTimeToIso(chromeTime("2026-01-15T12:00:00Z"), now), "2026-01-15");
  // Inside the clock-skew allowance: kept. Well past it: dropped.
  assert.ok(chromeTimeToIso(chromeTime("2026-01-16T00:00:00Z"), now) !== null);
  assert.equal(chromeTimeToIso(String(Number(chromeTime("2026-01-15T12:00:00Z")) + (MAX_CLOCK_SKEW_MS + 60_000) * 1000), now), null);
});

test("chromeTimeToIso: a pre-1970 imported bookmark is still a real date", () => {
  assert.equal(chromeTimeToIso(chromeTime("1995-06-15T12:00:00Z")), "1995-06-15");
});

// --- chromeBase / bookmarksPath -------------------------------------------

test("chromeBase: macOS path", () => {
  // Normalize separators: path.join uses "\" when the test host is Windows,
  // regardless of which platform's layout we ask for.
  assert.match(
    chromeBase("darwin", {}).replaceAll("\\", "/"),
    /Library\/Application Support\/Google\/Chrome$/,
  );
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
  const p = bookmarksPath({ MNEMOS_BOOKMARKS_BROWSER: "chrome", CHROME_PROFILE: "" }, "darwin").replaceAll("\\", "/");
  assert.match(p, /\/Default\/Bookmarks$/);
});

test("chromeBase regression: an empty env var means unset, never a relative path", () => {
  // `??` let "" through and produced e.g. "google-chrome", silently resolved
  // against the process cwd. The XDG spec says empty means unset.
  for (const [platform, env] of [
    ["win32", { LOCALAPPDATA: "" }],
    ["linux", { XDG_CONFIG_HOME: "" }],
  ]) {
    const base = chromeBase(platform, env);
    assert.ok(path.isAbsolute(base), `${platform} with empty env var gave relative: ${base}`);
    assert.ok(path.isAbsolute(bookmarksPath({ ...env, MNEMOS_BOOKMARKS_BROWSER: "chrome" }, platform)));
  }
});

// --- cap -------------------------------------------------------------------

test("cap: default, ceiling, and floor", () => {
  assert.equal(cap(undefined, 100), 100);
  assert.equal(cap(500, 100), 200);
  // limit 0 means 0. It used to floor at 1, which answered a request for
  // nothing with an arbitrary single item; total_matches still tells the
  // caller how many there were, so returning none is the honest answer.
  assert.equal(cap(0, 100), 0);
  assert.equal(cap(-5, 100), 0);
});

test("cap: custom max (top_domains uses 100, not 200)", () => {
  assert.equal(cap(500, 25, 100), 100);
  assert.equal(cap(undefined, 25, 100), 25);
});

test("cap regression: non-finite limit falls back instead of poisoning slice", () => {
  // cap(NaN) used to return NaN, and slice(0, NaN) is [] — an empty list
  // alongside a non-zero total_matches. Zod blocks NaN at the MCP boundary,
  // but cap is exported and must not rely on that.
  // Every non-finite value takes the same route: use the default.
  assert.equal(cap(NaN, 100), 100);
  assert.equal(cap(Infinity, 100), 100);
  assert.equal(cap(-Infinity, 100), 100);
  assert.equal([1, 2, 3].slice(0, cap(NaN, 2)).length, 2);
});
