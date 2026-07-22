// Fixture-based tests for the tool implementations: point the server's env
// override at a synthetic Bookmarks file containing every edge case at once.
// node:test runs each test file in its own process, so mutating process.env
// here cannot leak into other test files.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../dist/lib.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/bookmarks.json", import.meta.url));

beforeEach(() => {
  process.env.CHROME_BOOKMARKS_PATH = FIXTURE;
});

// --- search ----------------------------------------------------------------

test("search: AND-matching across title, URL, and folder path", () => {
  const r = lib.searchBookmarks("anthropic docs");
  assert.equal(r.total_matches, 1);
  assert.equal(r.matches[0].title, "Anthropic docs");
});

test("search: query word matches via folder path too (documented behavior)", () => {
  const r = lib.searchBookmarks("painting");
  assert.equal(r.total_matches, 1);
  assert.equal(r.matches[0].title, "Watercolor basics");
});

test("search: Greek query", () => {
  const r = lib.searchBookmarks("Καβάφης");
  assert.equal(r.total_matches, 1);
});

test("search regression: empty query is rejected, not 'match everything'", () => {
  const r = lib.searchBookmarks("   ");
  assert.ok(r.error && /empty query/i.test(r.error));
});

test("search: total_matches reports the pre-truncation count", () => {
  const r = lib.searchBookmarks("https", undefined, 2);
  assert.ok(r.total_matches > 2);
  assert.equal(r.matches.length, 2);
});

test("search: folder filter uses word-boundary segment matching", () => {
  const inAi = lib.searchBookmarks("https", "ai");
  assert.ok(inAi.matches.every((m) => m.folder.includes("AI")));
  assert.equal(inAi.total_matches, 2); // OpenAI + Anthropic docs, not Painting
});

// --- folders ---------------------------------------------------------------

test("list_folders: counts and the › separator", () => {
  const r = lib.listFolders();
  assert.equal(r.total_bookmarks, 12);
  const ai = r.folders.find((f) => f.folder === `Bookmarks Bar${lib.SEP}AI`);
  assert.equal(ai.bookmarks, 2);
});

test("list_folder_contents regression: 'ai' does not leak 'Painting' contents", () => {
  const r = lib.listFolderContents("ai");
  assert.equal(r.total_matches, 2);
  assert.ok(r.bookmarks.every((b) => !b.folder.includes("Painting")));
});

test("list_folder_contents regression: Greek folder is reachable", () => {
  const r = lib.listFolderContents("Ελληνική");
  assert.equal(r.total_matches, 1);
});

test("list_folder_contents regression: slash-named folder matches by full name", () => {
  const r = lib.listFolderContents("Vision / OCR");
  assert.equal(r.total_matches, 1);
  assert.equal(r.bookmarks[0].title, "Tesseract");
});

test("list_folder_contents: empty name is rejected", () => {
  const r = lib.listFolderContents("  ");
  assert.ok(r.error);
});

// --- recent ----------------------------------------------------------------

test("recent regression: corrupt future timestamp does not float to the top", () => {
  const r = lib.recentBookmarks(3);
  const titles = r.bookmarks.map((b) => b.title);
  assert.ok(!titles.includes("Corrupt future date"));
  // The three genuinely-newest bookmarks all carry the 2025-06-01 timestamp.
  assert.deepEqual(new Set(r.bookmarks.map((b) => b.added)), new Set(["2025-06-01"]));
});

test("recent: corrupt timestamp renders added: null instead of throwing", () => {
  const r = lib.recentBookmarks(200);
  const corrupt = r.bookmarks.find((b) => b.title === "Corrupt future date");
  assert.equal(corrupt.added, null);
});

// --- domains ---------------------------------------------------------------

test("top_domains regression: chrome:// and javascript: are excluded", () => {
  const r = lib.topDomains(100);
  const names = r.domains.map((d) => d.domain);
  assert.ok(!names.includes("settings"));
  assert.ok(names.every((n) => n.includes(".")));
});

test("top_domains: www-stripping and counting", () => {
  const r = lib.topDomains(100);
  const github = r.domains.find((d) => d.domain === "github.com");
  assert.equal(github.bookmarks, 3); // tesseract + a/one + www. a/two
});

test("top_domains regression: IDN renders as Unicode, not punycode", () => {
  const r = lib.topDomains(100);
  const names = r.domains.map((d) => d.domain);
  assert.ok(names.includes("εχαμπλε.gr"));
  assert.ok(!names.some((n) => n.startsWith("xn--")));
});

// --- error paths -----------------------------------------------------------

test("missing bookmarks file: friendly error, not ENOENT", () => {
  process.env.CHROME_BOOKMARKS_PATH = path.join(os.tmpdir(), "mnemos-does-not-exist", "Bookmarks");
  assert.throws(() => lib.listFolders(), /No bookmarks file at .*Set CHROME_PROFILE/s);
});

test("malformed JSON: friendly mid-write error", () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-")), "Bookmarks");
  fs.writeFileSync(bad, "{ not json");
  process.env.CHROME_BOOKMARKS_PATH = bad;
  assert.throws(() => lib.listFolders(), /not valid JSON.*mid-write/s);
});
