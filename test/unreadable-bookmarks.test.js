// A bookmarks file that cannot be read is reported by why: only a missing file
// (ENOENT) gets the "No bookmarks file" message and its list of profiles; a
// directory or a file mnemos may not read names the error code and the path.
// node:test runs each test file in its own process, so mutating process.env
// here cannot leak into other test files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "../dist/lib.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-test-"));

function messageFor(file) {
  process.env.CHROME_BOOKMARKS_PATH = file;
  try {
    lib.loadRoots();
  } catch (e) {
    return e.message;
  }
  assert.fail(`loadRoots() read ${file}`);
}

test("ENOENT: a missing file keeps the missing-file message", () => {
  const file = path.join(tmp(), "Bookmarks");
  const message = messageFor(file);
  assert.ok(message.startsWith(`No bookmarks file at ${file}.`), message);
  assert.match(message, /--profile or MNEMOS_PROFILE/);
  assert.doesNotMatch(message, /Cannot read/);
});

test("EISDIR: a directory is reported as a directory, not as missing", () => {
  const dir = tmp();
  const message = messageFor(dir);
  assert.ok(message.includes(`Cannot read the bookmarks file at ${dir} (EISDIR)`), message);
  assert.match(message, /is a directory/);
  assert.doesNotMatch(message, /No bookmarks file/);
});

test(
  "EACCES: a file mnemos may not read is reported as unreadable, not as missing",
  {
    skip:
      process.platform === "win32"
        ? "chmod does not deny reads on Windows"
        : process.getuid?.() === 0
          ? "root reads any file"
          : false,
  },
  () => {
    const file = path.join(tmp(), "Bookmarks");
    fs.writeFileSync(file, '{"roots":{}}');
    fs.chmodSync(file, 0o000);
    try {
      const message = messageFor(file);
      assert.ok(message.includes(`Cannot read the bookmarks file at ${file} (EACCES)`), message);
      assert.match(message, /permission was denied/);
      assert.doesNotMatch(message, /No bookmarks file/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  },
);
