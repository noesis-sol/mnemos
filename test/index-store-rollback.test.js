// immediate() in index-store.ts: a transaction that SQLite rolls back itself
// (a full disk, here a page limit) rethrows the error that ended it, not the
// "cannot rollback - no transaction is active" that ROLLBACK would add.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { immediate, isCorrupt } from "../dist/index-store.js";

/** An in-memory database that holds at most 10 pages, so inserts soon fail with SQLITE_FULL. */
function tinyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x TEXT)");
  db.exec("PRAGMA max_page_count = 10");
  return db;
}

function fillUp(db) {
  const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
  for (let i = 0; i < 1000; i++) insert.run("x".repeat(1000));
}

test("a transaction that fails with SQLITE_FULL rethrows 'database or disk is full'", () => {
  const db = tinyDatabase();
  try {
    let thrown;
    assert.throws(
      () => immediate(db, () => fillUp(db)),
      (err) => {
        thrown = err;
        return true;
      },
    );
    assert.match(thrown.message, /database or disk is full/);
    assert.equal(thrown.errcode & 0xff, 13); // SQLITE_FULL
    assert.equal(isCorrupt(thrown), false);
    // The connection is out of the transaction and takes the next one.
    if (db.isTransaction !== undefined) assert.equal(db.isTransaction, false);
    assert.equal(immediate(db, () => 42), 42);
  } finally {
    db.close();
  }
});

test("a transaction that fails while still open is rolled back and rethrows its error", () => {
  const db = tinyDatabase();
  try {
    assert.throws(
      () =>
        immediate(db, () => {
          db.prepare("INSERT INTO t (x) VALUES ('kept out')").run();
          throw new Error("boom");
        }),
      /^Error: boom$/,
    );
    if (db.isTransaction !== undefined) assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM t").get().n, 0);
  } finally {
    db.close();
  }
});
