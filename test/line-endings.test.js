// .gitattributes keeps every checkout's line endings what the generators
// write, so tests that compare generated files byte for byte with committed
// ones (icons.test.js against src/icon.ts) pass on Windows, where git's
// core.autocrlf would otherwise check text files out with CRLF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The attributes git applies to each path, as { path: { attr: value } }. */
function checkAttr(attrs, paths) {
  const out = execFileSync("git", ["check-attr", ...attrs, "--", ...paths], { cwd: ROOT, encoding: "utf8" });
  const result = {};
  for (const line of out.trim().split("\n")) {
    const [file, attr, value] = line.split(": ");
    (result[file] ??= {})[attr] = value;
  }
  return result;
}

test("line endings: generated and source text files check out with LF", () => {
  const paths = ["src/icon.ts", "src/index.ts", "scripts/build-icons.mjs", "assets/star-plus-light.svg"];
  const attrs = checkAttr(["text", "eol"], paths);
  for (const p of paths) {
    assert.deepEqual(attrs[p], { text: "auto", eol: "lf" }, p);
  }
});

test("line endings: PNG assets are binary, never converted", () => {
  const paths = ["assets/star-plus-dark-48.png", "assets/star-plus-light-96.png"];
  const attrs = checkAttr(["text", "diff", "merge"], paths);
  for (const p of paths) {
    assert.deepEqual(attrs[p], { text: "unset", diff: "unset", merge: "unset" }, p);
  }
});
