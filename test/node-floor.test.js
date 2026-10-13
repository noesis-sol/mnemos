// Node floor: package.json's engines.node is >=22.13 (node:sqlite is unflagged
// from 22.13), package-lock.json's root entry agrees with it, the Node running
// the tests meets it, and CI tests the floor's major and the newest LTS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("package.json requires Node 22.13 or later", () => {
  assert.equal(pkg.engines.node, ">=22.13");
});

test("package-lock.json's root entry carries the same engines", () => {
  const lock = JSON.parse(read("package-lock.json"));
  assert.deepEqual(lock.packages[""].engines, pkg.engines);
});

test("the running Node meets the floor", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node}`);
});

test("CI runs Node 22 and 24", () => {
  const matrix = read(".github/workflows/ci.yml").match(/^\s*node: \[(.*)\]\s*$/m);
  assert.ok(matrix, "no node matrix in ci.yml");
  assert.deepEqual(matrix[1].split(",").map((v) => v.trim()), ["22", "24"]);
});
