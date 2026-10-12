// The icons inlined in src/icon.ts (built to dist/icon.js) against their
// sources: each data URI holds exactly the bytes of one file in assets/, with
// the mimeType, sizes and theme its file name implies, and the committed
// src/icon.ts is what scripts/build-icons.mjs renders from assets/ today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICONS } from "../dist/icon.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = path.join(ROOT, "assets");

/** What an asset's name says: star-plus-<theme>.svg or star-plus-<theme>-<px>.png. */
function expectedFor(file) {
  const m = /^star-plus-(light|dark)(?:-(\d+))?\.(svg|png)$/.exec(file);
  assert.ok(m, `unexpected asset name ${file}`);
  const [, theme, px, ext] = m;
  return ext === "svg"
    ? { mimeType: "image/svg+xml", sizes: ["any"], theme }
    : { mimeType: "image/png", sizes: [`${px}x${px}`], theme };
}

/** Split a base64 data URI into its media type and decoded bytes. */
function decode(src) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(src);
  assert.ok(m, `not a base64 data URI: ${src.slice(0, 40)}…`);
  return { mediaType: m[1], bytes: Buffer.from(m[2], "base64") };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.equal(bytes.toString("latin1", 12, 16), "IHDR");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

const assets = readdirSync(ASSETS)
  .filter((f) => /\.(svg|png)$/.test(f))
  .map((file) => ({ file, bytes: readFileSync(path.join(ASSETS, file)) }));

test("icons: each data URI decodes to exactly the bytes of one asset file", () => {
  assert.equal(ICONS.length, assets.length, "one icon per asset");
  const matched = ICONS.map((icon) => {
    const { mediaType, bytes } = decode(icon.src);
    assert.equal(mediaType, icon.mimeType, "data URI media type matches mimeType");
    const hits = assets.filter((a) => a.bytes.equals(bytes));
    assert.equal(hits.length, 1, `icon ${icon.theme} ${icon.sizes} matches exactly one asset`);
    return hits[0].file;
  });
  assert.deepEqual([...matched].sort(), assets.map((a) => a.file).sort(), "every asset is inlined once");
});

test("icons: mimeType, sizes and theme match the asset each icon inlines", () => {
  for (const icon of ICONS) {
    const { bytes } = decode(icon.src);
    const { file } = assets.find((a) => a.bytes.equals(bytes));
    assert.deepEqual(
      { mimeType: icon.mimeType, sizes: icon.sizes, theme: icon.theme },
      expectedFor(file),
      file,
    );
    if (icon.mimeType === "image/png") {
      assert.deepEqual([pngSize(bytes)], icon.sizes, `${file} pixel size`);
    } else {
      assert.match(bytes.toString("utf8"), /^<svg[\s>]/, `${file} is SVG markup`);
    }
  }
});

test("icons: one light and one dark icon per format and size", () => {
  const keys = ICONS.map((i) => `${i.mimeType} ${i.sizes.join(",")} ${i.theme}`).sort();
  assert.deepEqual(keys, [
    "image/png 48x48 dark",
    "image/png 48x48 light",
    "image/png 96x96 dark",
    "image/png 96x96 light",
    "image/svg+xml any dark",
    "image/svg+xml any light",
  ]);
});

test("icons: committed src/icon.ts equals what build-icons.mjs renders from assets/", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mnemos-icons-"));
  try {
    const out = path.join(dir, "icon.ts");
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-icons.mjs"), out], {
      stdio: "pipe",
    });
    assert.equal(
      readFileSync(path.join(ROOT, "src", "icon.ts"), "utf8"),
      readFileSync(out, "utf8"),
      "src/icon.ts is stale: run node scripts/build-icons.mjs",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
