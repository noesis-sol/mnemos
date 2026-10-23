// Unsupported Node in CI: the old-node job runs e2e/old-node.e2e.js on Node 18
// (the MCP SDK's minimum, which cli.ts and unsupported-node.ts must still load
// on) and on Node 20.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = ci.match(/^  old-node:\n((?:(?:    .*)?\n)*)/m)?.[1];

test("CI has an old-node job", () => {
  assert.ok(job, "no old-node job in ci.yml");
});

test("the old-node job runs Node 18 and 20", () => {
  const matrix = job.match(/^\s*node: \[(.*)\]\s*$/m);
  assert.ok(matrix, "no node matrix in the old-node job");
  assert.deepEqual(matrix[1].split(",").map((v) => v.trim()), ["18", "20"]);
  assert.match(job, /node-version: \$\{\{ matrix\.node \}\}/);
});

test("the old-node job builds and runs the old-node e2e", () => {
  assert.match(job, /- run: npm run build\n/);
  assert.match(job, /- run: node --test e2e\/old-node\.e2e\.js\n/);
});
