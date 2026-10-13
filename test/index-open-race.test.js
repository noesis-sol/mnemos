// Several processes opening one new index at the same moment (two servers
// started together on one cache directory): each opens it, none fails with
// "database is locked", and the file ends in WAL mode. SQLite answers a
// connection switching a new file to WAL SQLITE_BUSY without waiting in the
// busy handler when another switches it at once; IndexStore.open waits and
// tries again. Each process (dist/index-store.js) spins until a shared start
// time, so their opens meet.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexFile } from "../dist/index-store.js";

const STORE = new URL("../dist/index-store.js", import.meta.url).href;

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-index-open-race-"));
  dirs.push(dir);
  return dir;
}

// Opens the index, takes and gives back the fetcher's lease, and prints "ok" or the error.
const OPENER = `
const { IndexStore } = await import(process.argv[1]);
const [bookmarksFile, dir, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
try {
  const store = IndexStore.open({ bookmarksFile, dir });
  store.acquireLease("race", 30_000);
  store.releaseLease("race");
  store.close();
  console.log("ok");
} catch (err) {
  console.log(String(err?.message ?? err));
}
`;

function open(bookmarksFile, dir, at) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", OPENER, STORE, bookmarksFile, dir, String(at)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

test("processes opening one new index at once all open it, in WAL mode", async () => {
  const rounds = 8;
  const processes = 6;
  for (let round = 0; round < rounds; round++) {
    const dir = tempDir();
    const bookmarksFile = path.join(dir, "Bookmarks");
    const cache = path.join(dir, "cache");
    // Late enough for every process to have started and loaded the store.
    const at = Date.now() + 1_000;
    const results = await Promise.all(Array.from({ length: processes }, () => open(bookmarksFile, cache, at)));
    assert.deepEqual(results, Array(processes).fill("ok"), `round ${round}`);
    const db = new DatabaseSync(indexFile(bookmarksFile, cache));
    try {
      assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    } finally {
      db.close();
    }
  }
});
