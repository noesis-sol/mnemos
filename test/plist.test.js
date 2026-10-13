// The binary plist reader (src/plist.ts) that Safari's Bookmarks.plist goes
// through: decoding a fixture written by Python's plistlib, an independent
// encoder, and refusing hand-built malformed files with an Error instead of a
// crash or a hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBinaryPlist, parseBinaryPlist } from "../dist/plist.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fs.readFileSync(path.join(ROOT, "test", "fixtures", "safari-bookmarks.plist"));

/**
 * A binary plist from raw object bytes: `objects[i]` is object i, references
 * and offsets are `size` bytes wide, and `top` is the root object.
 */
function bplist(objects, { top = 0, size = 1 } = {}) {
  const offsets = [];
  let pos = 8;
  for (const object of objects) {
    offsets.push(pos);
    pos += object.length;
  }
  const table = Buffer.alloc(offsets.length * size);
  offsets.forEach((o, i) => table.writeUIntBE(o, i * size, size));
  const trailer = Buffer.alloc(32);
  trailer[6] = size;
  trailer[7] = size;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([Buffer.from("bplist00"), ...objects, table, trailer]);
}

const bytes = (...values) => Buffer.from(values);
const ascii = (text) => Buffer.concat([bytes(0x50 | text.length), Buffer.from(text, "latin1")]);

test("plist: the plistlib fixture decodes to its dicts, arrays and strings", () => {
  assert.ok(isBinaryPlist(FIXTURE));
  const root = parseBinaryPlist(FIXTURE);
  assert.equal(root.WebBookmarkType, "WebBookmarkTypeList");
  assert.equal(root.WebBookmarkFileVersion, 1);
  const titles = root.Children.map((c) => c.Title ?? c.URIDictionary.title);
  assert.deepEqual(titles, [
    "History",
    "BookmarksBar",
    "BookmarksMenu",
    "Recipes",
    "com.apple.ReadingList",
    "Loose bookmark",
  ]);
});

test("plist: UTF-16 strings, dates, data, integers, reals and booleans", () => {
  const root = parseBinaryPlist(FIXTURE);
  const greek = root.Children[1].Children[1];
  assert.equal(greek.Title, "Ελληνικά");
  assert.equal(greek.Children[0].URIDictionary.title, "Βικιπαίδεια");
  const reading = root.Children[4].Children[0].ReadingList;
  assert.ok(reading.DateAdded instanceof Date);
  assert.equal(reading.DateAdded.toISOString(), "2024-05-01T12:00:00.000Z");
  assert.ok(Buffer.isBuffer(root.Sync.Key));
  assert.deepEqual([...root.Sync.Key.subarray(0, 3)], [0, 1, 2]);
  assert.equal(root.Sync.ServerVersion, 70000);
  assert.equal(root.Sync.Big, 2 ** 40);
  assert.equal(root.Sync.Ratio, 0.5);
  assert.equal(root.Children[3].Children[0].ShouldOmitFromUI, false);
});

test("plist: integer widths, a negative 8-byte integer, a UID and a long string", () => {
  const long = "x".repeat(20);
  const plist = bplist([
    bytes(0xa6, 1, 2, 3, 4, 5, 6),
    bytes(0x10, 0xff),
    bytes(0x11, 0x01, 0x00),
    bytes(0x12, 0x00, 0x01, 0x00, 0x00),
    bytes(0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    bytes(0x80, 0x07),
    Buffer.concat([bytes(0x5f, 0x10, long.length), Buffer.from(long)]),
  ]);
  assert.deepEqual(parseBinaryPlist(plist), [255, 256, 65536, -1, 7, long]);
});

test("plist: an object referenced twice decodes once to equal values", () => {
  assert.deepEqual(parseBinaryPlist(bplist([bytes(0xa2, 1, 1), ascii("x")])), ["x", "x"]);
});

test("plist: a container that contains itself is an error, not a hang", () => {
  assert.throws(() => parseBinaryPlist(bplist([bytes(0xa1, 0)])), /contains itself/);
});

test("plist: nesting past the depth limit is an error, not a stack overflow", () => {
  const depth = 3000;
  const objects = [];
  for (let i = 0; i < depth; i++) {
    const next = Buffer.alloc(3);
    next[0] = 0xa1;
    next.writeUInt16BE(i + 1, 1);
    objects.push(next);
  }
  objects.push(ascii("bottom"));
  assert.throws(() => parseBinaryPlist(bplist(objects, { size: 2 })), /nested too deeply/);
});

test("plist: malformed files throw Errors", () => {
  const cases = {
    "no header": Buffer.from("not a plist at all, but long enough to have a trailer"),
    truncated: FIXTURE.subarray(0, FIXTURE.length - 10),
    "only the header": Buffer.from("bplist00"),
    "reference out of range": bplist([bytes(0xa1, 9)]),
    "top object out of range": bplist([ascii("x")], { top: 4 }),
    "unknown marker": bplist([bytes(0xf0)]),
    "string past the object area": bplist([bytes(0x5e, 0x41)]),
    "non-string dictionary key": bplist([bytes(0xd1, 1, 1), bytes(0x10, 1)]),
  };
  for (const [name, buf] of Object.entries(cases)) {
    assert.throws(() => parseBinaryPlist(buf), Error, name);
  }
});
