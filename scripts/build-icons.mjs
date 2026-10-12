/**
 * Regenerate src/icon.ts from the image files in assets/.
 *
 * The MCP Icon type (spec rev 2025-11-25, SEP-973) takes a `src` URI. A stdio
 * server has no HTTP origin to serve icons from, so the images are inlined as
 * base64 data URIs and shipped inside dist/.
 *
 * Run with: node scripts/build-icons.mjs [output path]
 *
 * The output path defaults to src/icon.ts; test/icons.test.js passes a scratch
 * path to compare a fresh render with the committed file.
 *
 * The PNGs in assets/ are rasterized from the SVGs and committed, so this
 * script needs no SVG rasterizer and runs on any platform.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = process.argv[2] ? resolve(process.argv[2]) : join(root, "src", "icon.ts");

/** One entry per (theme, format, size). `sizes: ["any"]` marks the scalable SVG. */
const SOURCES = [
  { file: "star-plus-light.svg", mimeType: "image/svg+xml", sizes: ["any"], theme: "light" },
  { file: "star-plus-dark.svg", mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
  { file: "star-plus-light-48.png", mimeType: "image/png", sizes: ["48x48"], theme: "light" },
  { file: "star-plus-dark-48.png", mimeType: "image/png", sizes: ["48x48"], theme: "dark" },
  { file: "star-plus-light-96.png", mimeType: "image/png", sizes: ["96x96"], theme: "light" },
  { file: "star-plus-dark-96.png", mimeType: "image/png", sizes: ["96x96"], theme: "dark" },
];

const icons = SOURCES.map(({ file, mimeType, sizes, theme }) => ({
  src: `data:${mimeType};base64,${readFileSync(join(root, "assets", file)).toString("base64")}`,
  mimeType,
  sizes,
  theme,
}));

const bytes = icons.reduce((n, i) => n + i.src.length, 0);

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-icons.mjs
//
// Source images live in assets/. The mark is Lucide's "star-plus" (ISC), with
// \`currentColor\` replaced by an explicit amber: a data URI has no CSS context
// to inherit from, so \`currentColor\` would resolve to black and disappear on
// dark backgrounds. Light-theme variants use a darker gold (#B8860B, 3.25:1 on
// white) since Amber 500 only reaches 1.63:1 there.
//
// Total inlined size: ~${(bytes / 1024).toFixed(1)} KB, sent once per session on \`initialize\`.
//
// The \`Icon\` type and \`Implementation.icons\` first ship in SDK 1.18.0, which
// is why package.json floors the dependency there rather than at 1.12.

import type { Icon } from "@modelcontextprotocol/sdk/types.js";

export const ICONS: Icon[] = ${JSON.stringify(icons, null, 2)};
`;

writeFileSync(outPath, out);
console.log(`wrote ${relative(root, outPath)} — ${icons.length} icons, ${(bytes / 1024).toFixed(1)} KB inlined`);
