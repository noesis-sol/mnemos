// Edge cases for list_folders and list_folder_contents: ordering, root labels,
// unnamed and same-named folders, the no-match note, and limit handling. Each
// test writes its own Bookmarks file, so the shared fixture stays untouched.
// node:test runs each test file in its own process, so mutating process.env
// here cannot leak into other test files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";

const { SEP } = lib;

const url = (name) => ({ type: "url", name, url: `https://${name}.example/` });
const folder = (name, children) => ({ type: "folder", name, children });

/** Write `roots` to a fresh Bookmarks file and point the library at it. */
function useRoots(roots) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-folders-")), "Bookmarks");
  fs.writeFileSync(file, JSON.stringify({ roots }));
  process.env.CHROME_BOOKMARKS_PATH = file;
}

// --- list_folders ------------------------------------------------------------

test("list_folders: folders come back sorted by name with localeCompare", () => {
  useRoots({
    bookmark_bar: folder("", [folder("Zeta", []), folder("beta", []), folder("Alpha", [])]),
  });
  const names = lib.listFolders().folders.map((f) => f.folder);
  // A plain code-unit sort would put "Zeta" before "Alpha" and "beta".
  assert.deepEqual(names, [
    "Bookmarks Bar",
    `Bookmarks Bar${SEP}Alpha`,
    `Bookmarks Bar${SEP}beta`,
    `Bookmarks Bar${SEP}Zeta`,
  ]);
});

test("list_folders: an unknown root key is labelled with the key itself", () => {
  useRoots({
    bookmark_bar: folder("", []),
    custom_root: folder("ignored name", [url("a"), folder("Inner", [url("b")])]),
  });
  const r = lib.listFolders();
  const custom = r.folders.find((f) => f.folder === "custom_root");
  assert.ok(custom, "the root is listed under its key");
  assert.equal(custom.bookmarks, 1);
  assert.equal(custom.subtree_bookmarks, 2);
  assert.ok(r.folders.some((f) => f.folder === `custom_root${SEP}Inner`));
  assert.equal(lib.listFolderContents("custom_root").total_matches, 2);
});

test("list_folders: a folder with no name gets an empty last segment", () => {
  useRoots({
    bookmark_bar: folder("", [{ type: "folder", children: [url("a"), url("b")] }]),
  });
  const r = lib.listFolders();
  const unnamed = r.folders.find((f) => f.folder === `Bookmarks Bar${SEP}`);
  assert.ok(unnamed, "the unnamed folder is listed");
  assert.equal(unnamed.bookmarks, 2);
  assert.equal(unnamed.subtree_bookmarks, 2);
  const bar = r.folders.find((f) => f.folder === "Bookmarks Bar");
  assert.equal(bar.bookmarks, 0);
  assert.equal(bar.subtree_bookmarks, 2);
  assert.equal(r.total_bookmarks, 2);
});

test("list_folders: sibling folders with the same name merge into one row", () => {
  useRoots({
    bookmark_bar: folder("", [
      folder("Dup", [url("a"), url("b"), folder("Sub", [url("c")])]),
      folder("Dup", [url("d"), folder("Sub", [url("e"), url("f")])]),
    ]),
  });
  const r = lib.listFolders();
  const rows = (name) => r.folders.filter((f) => f.folder === name);

  const dup = rows(`Bookmarks Bar${SEP}Dup`);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].bookmarks, 3);
  assert.equal(dup[0].subtree_bookmarks, 6);

  const sub = rows(`Bookmarks Bar${SEP}Dup${SEP}Sub`);
  assert.equal(sub.length, 1);
  assert.equal(sub[0].bookmarks, 3);
  assert.equal(sub[0].subtree_bookmarks, 3);

  assert.equal(r.total_bookmarks, 6);
});

// --- list_folder_contents ----------------------------------------------------

test("list_folder_contents: no matching folder gives total 0 and a note", () => {
  useRoots({ bookmark_bar: folder("", [folder("Reading", [url("a")])]) });
  const r = lib.listFolderContents("Nonexistent");
  assert.deepEqual(r, {
    total_matches: 0,
    bookmarks: [],
    note: 'No folder matches "Nonexistent".',
    sources: [{ browser: "chrome", profile: null, bookmarks: process.env.CHROME_BOOKMARKS_PATH }],
  });
});

test("list_folder_contents: limit 0, default 100 and cap 200 keep total_matches", () => {
  const many = Array.from({ length: 250 }, (_, i) => url(`site${i}`));
  useRoots({ bookmark_bar: folder("", [folder("Big", many)]) });

  const zero = lib.listFolderContents("Big", 0);
  assert.equal(zero.total_matches, 250);
  assert.equal(zero.bookmarks.length, 0);

  const byDefault = lib.listFolderContents("Big");
  assert.equal(byDefault.total_matches, 250);
  assert.equal(byDefault.bookmarks.length, 100);

  const capped = lib.listFolderContents("Big", 500);
  assert.equal(capped.total_matches, 250);
  assert.equal(capped.bookmarks.length, 200);

  const some = lib.listFolderContents("Big", 150);
  assert.equal(some.total_matches, 250);
  assert.equal(some.bookmarks.length, 150);
  // Truncation keeps document order: the first bookmarks come first.
  assert.equal(some.bookmarks[0].title, "site0");
  assert.equal(some.bookmarks[149].title, "site149");
});

test("list_folder_contents: a root label matches that whole root", () => {
  useRoots({
    bookmark_bar: folder("", [url("bar-top"), folder("Work", [url("bar-work")])]),
    other: folder("", [url("other-top"), folder("Later", [url("other-later")])]),
    synced: folder("", [url("phone")]),
  });
  const r = lib.listFolderContents("Other Bookmarks");
  assert.equal(r.total_matches, 2);
  assert.deepEqual(
    r.bookmarks.map((b) => [b.title, b.folder]),
    [
      ["other-top", "Other Bookmarks"],
      ["other-later", `Other Bookmarks${SEP}Later`],
    ],
  );
});
