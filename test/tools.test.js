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

test("search regression: a short query no longer matches mid-word", () => {
  // "ai" used to pull in Gmail ("Gm-ai-l") and Watercolor basics
  // ("P-ai-nting") — the same false positives the folder matcher rejects.
  const r = lib.searchBookmarks("ai");
  const titles = r.matches.map((m) => m.title);
  assert.ok(!titles.includes("Gmail"));
  assert.ok(!titles.includes("Watercolor basics"));
  assert.deepEqual(new Set(titles), new Set(["OpenAI", "Anthropic docs"]));
});

test("search: prefixes still match, so partial words remain useful", () => {
  assert.equal(lib.searchBookmarks("anthrop").total_matches, 1);
  assert.equal(lib.searchBookmarks("watercol").total_matches, 1);
});

test("search regression: an unmatched folder filter says so", () => {
  // Otherwise a mistyped folder name reads as "the user saved nothing on this".
  const r = lib.searchBookmarks("openai", "NoSuchFolder");
  assert.equal(r.total_matches, 0);
  assert.match(r.note, /NoSuchFolder/);
  assert.match(r.note, /list_folders/);
});

test("search: a blank optional folder filter is ignored, not an error", () => {
  const blank = lib.searchBookmarks("openai", "   ");
  assert.equal(blank.total_matches, lib.searchBookmarks("openai").total_matches);
});

test("search regression: nodes missing `type` are not dropped", () => {
  // Chrome always writes `type`, but CHROME_BOOKMARKS_PATH accepts any file
  // and third-party exports omit it — a missing `type` used to silently drop
  // the node, and with it every bookmark underneath a folder.
  // Both hit: the untyped URL by title, the buried one via its folder path.
  assert.deepEqual(
    new Set(lib.searchBookmarks("untyped").matches.map((m) => m.title)),
    new Set(["Untyped link", "Buried under an untyped folder"]),
  );
  assert.equal(lib.searchBookmarks("buried").total_matches, 1);
  assert.equal(lib.listFolderContents("Untyped folder").total_matches, 1);
});

// --- folders ---------------------------------------------------------------

test("list_folders: counts and the › separator", () => {
  const r = lib.listFolders();
  assert.equal(r.total_bookmarks, 16);
  const ai = r.folders.find((f) => f.folder === `Bookmarks Bar${lib.SEP}AI`);
  assert.equal(ai.bookmarks, 2);
});

test("list_folders regression: folders with no direct bookmarks are still listed", () => {
  // Counting only URL entries made empty folders vanish and container folders
  // invisible, so the model never learned those names existed — even though
  // they are part of the user's taxonomy.
  const folders = lib.listFolders().folders;
  const byName = (name) => folders.find((f) => f.folder === `Bookmarks Bar${lib.SEP}${name}`);

  const empty = byName("Empty Shelf");
  assert.ok(empty, "an empty folder is part of the taxonomy");
  assert.equal(empty.bookmarks, 0);
  assert.equal(empty.subtree_bookmarks, 0);

  // A folder holding only subfolders reports 0 direct but a non-zero subtree,
  // which is what list_folder_contents on that name would actually return.
  const research = byName("Research");
  assert.equal(research.bookmarks, 0);
  assert.equal(research.subtree_bookmarks, 1);
  assert.equal(lib.listFolderContents("Research").total_matches, research.subtree_bookmarks);

  // Roots appear even when the profile never used them.
  assert.ok(folders.some((f) => f.folder === "Mobile Bookmarks"));
});

test("list_folders: non-tree values in `roots` never become folders", () => {
  // The fixture carries Chrome's "sync_transaction_version" string; an object
  // that is not folder-shaped must be skipped too, now that list_folders
  // reports folders holding nothing.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-")), "Bookmarks");
  fs.writeFileSync(
    file,
    JSON.stringify({
      roots: {
        bookmark_bar: { type: "folder", children: [{ type: "url", name: "a", url: "https://a.co/" }] },
        sync_transaction_version: "1",
        meta_info: { some_key: "some_value" },
      },
    }),
  );
  process.env.CHROME_BOOKMARKS_PATH = file;
  const names = lib.listFolders().folders.map((f) => f.folder);
  assert.deepEqual(names, ["Bookmarks Bar"]);
});

test("list_folders: total_bookmarks still counts every bookmark exactly once", () => {
  const r = lib.listFolders();
  const direct = r.folders.reduce((sum, f) => sum + f.bookmarks, 0);
  assert.equal(direct, r.total_bookmarks);
  assert.equal(r.total_bookmarks, lib.recentBookmarks(1).total_matches);
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

test("recent regression: a *plausible* future date is rejected too, not just an impossible one", () => {
  // The old guard only caught values outside the JS Date range. A year-3000
  // date_added is a valid Date and sat at the top of every call.
  const r = lib.recentBookmarks(200);
  const corrupt = r.bookmarks.find((b) => b.title === "Corrupt plausible future date");
  assert.equal(corrupt.added, null);
  assert.ok(!r.bookmarks.slice(0, 3).some((b) => b.title === "Corrupt plausible future date"));
});

test("recent regression: reports total_matches so truncation is visible", () => {
  const r = lib.recentBookmarks(2);
  assert.equal(r.bookmarks.length, 2);
  assert.equal(r.total_matches, 16);
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

test("top_domains regression: reports total_matches so truncation is visible", () => {
  // The tool description tells the model to treat these as the user's approved
  // sources; a silently truncated list reads as the complete set.
  const all = lib.topDomains(100);
  const two = lib.topDomains(2);
  assert.equal(two.domains.length, 2);
  assert.equal(two.total_matches, all.domains.length);
  assert.ok(two.total_matches > 2);
});

// --- output bounds ---------------------------------------------------------

test("fmt: pathological titles and data: URIs are clipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-"));
  const file = path.join(dir, "Bookmarks");
  fs.writeFileSync(
    file,
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          children: [
            {
              type: "url",
              name: "T".repeat(200_000),
              url: `data:text/html,${"y".repeat(200_000)}`,
              date_added: "13349793600000000",
            },
          ],
        },
      },
    }),
  );
  process.env.CHROME_BOOKMARKS_PATH = file;
  const r = lib.recentBookmarks(1);
  const [only] = r.bookmarks;
  assert.ok(only.title.length < 1_000, `title still ${only.title.length} chars`);
  assert.ok(only.url.length < 3_000, `url still ${only.url.length} chars`);
  assert.ok(only.title.endsWith("…") && only.url.endsWith("…"));
  // One bookmark must not be able to dominate a tool result.
  assert.ok(JSON.stringify(r).length < 5_000);
});

test("fmt: a real long URL is never mangled", () => {
  // Clipping must not break links the model may hand back to the user.
  const long = `https://example.com/search?q=${"a".repeat(1_000)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-"));
  const file = path.join(dir, "Bookmarks");
  fs.writeFileSync(
    file,
    JSON.stringify({
      roots: { bookmark_bar: { type: "folder", children: [{ type: "url", name: "q", url: long }] } },
    }),
  );
  process.env.CHROME_BOOKMARKS_PATH = file;
  assert.equal(lib.recentBookmarks(1).bookmarks[0].url, long);
});

test("deeply nested folders do not overflow the stack", () => {
  // The recursive generator died at ~2k levels; JSON.parse itself survives
  // well past that, so the parser was never the limit.
  const depth = 5_000;
  const body =
    '{"roots":{"bookmark_bar":{"type":"folder","children":[' +
    '{"type":"folder","name":"f","children":['.repeat(depth) +
    '{"type":"url","name":"bottom","url":"https://deep.example/"}' +
    "]}".repeat(depth) +
    "]}}}";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-"));
  const file = path.join(dir, "Bookmarks");
  fs.writeFileSync(file, body);
  process.env.CHROME_BOOKMARKS_PATH = file;
  assert.equal(lib.searchBookmarks("bottom").total_matches, 1);
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

test("regression: a valid-JSON file that is not Chrome's errors, not 'no bookmarks'", () => {
  // These all parsed fine and produced an empty result, so pointing
  // CHROME_BOOKMARKS_PATH at the wrong file looked exactly like a user who
  // has never bookmarked anything.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-"));
  for (const body of ["[]", "null", '"hello"', "{}", '{"roots": null}', '{"roots": "oops"}']) {
    const file = path.join(dir, "Bookmarks");
    fs.writeFileSync(file, body);
    process.env.CHROME_BOOKMARKS_PATH = file;
    assert.throws(() => lib.listFolders(), /not a Chrome Bookmarks file|not valid JSON/, body);
  }
});

test("a genuinely empty profile is not mistaken for a foreign file", () => {
  // A brand-new Chrome profile has the roots with empty children arrays, and
  // must report zero bookmarks rather than throwing.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-")), "Bookmarks");
  fs.writeFileSync(
    file,
    JSON.stringify({
      roots: {
        bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [] },
        other: { type: "folder", name: "Other bookmarks", children: [] },
        synced: { type: "folder", name: "Mobile bookmarks", children: [] },
      },
      version: 1,
    }),
  );
  process.env.CHROME_BOOKMARKS_PATH = file;
  assert.equal(lib.listFolders().total_bookmarks, 0);
  assert.equal(lib.recentBookmarks().total_matches, 0);
  assert.equal(lib.topDomains().total_matches, 0);
});
