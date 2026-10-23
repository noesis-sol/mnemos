// The runtime install's timeout when the npm mnemos spawns is a wrapper that
// starts npm as a process of its own, as npm.cmd does on Windows through
// cmd.exe (mnemos-abn): the timeout still rejects, though that npm holds the
// output pipes, and on Windows taskkill ends it with the wrapper. Offline: the
// npm on the PATH is a stub, run without exec, that never exits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeInstallError, TRANSFORMERS, TRANSFORMERS_VERSION, loadTransformers, runtimeDir } from "../dist/runtime.js";

const WIN = process.platform === "win32";
let root;
let bin; // holds the wrapper npm
let noNpm; // a node with no npm beside it
let log; // where the stub npm records its pid

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-runtime-tree-"));
  bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stub = path.join(root, "npm-stub.mjs");
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 60_000);
`,
  );
  if (WIN) {
    fs.writeFileSync(path.join(bin, "npm.cmd"), `@"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    // No exec: the shell mnemos spawns waits on the stub, which shares its pipes.
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n"${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  }
  noNpm = path.join(root, "no-npm", "bin", WIN ? "node.exe" : "node");
  log = path.join(root, "stub.json");
});

// The stub outlives the wrapper off Windows: killed here, also when the test fails, as it would hold this file's pipes.
after(() => {
  try {
    process.kill(JSON.parse(fs.readFileSync(log, "utf8")).pid, "SIGKILL");
  } catch {
    // not started, or already gone
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

test("timeout: a wrapper npm whose npm holds the pipes still rejects, and on Windows its npm is killed too", { timeout: 30_000 }, async () => {
  const dir = path.join(root, "cache");
  const env = { ...process.env, STUB_LOG: log };
  delete env.npm_execpath;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${bin}${path.delimiter}${env[key] ?? ""}`;
  const missing = async () => {
    throw new Error(`Cannot find package '${TRANSFORMERS}' (test)`);
  };
  const started = Date.now();
  await assert.rejects(
    loadTransformers({ dir, spec: TRANSFORMERS_VERSION, importBeside: missing, env, execPath: noNpm, timeoutMs: 1500 }),
    (err) => {
      assert.ok(err instanceof RuntimeInstallError, String(err));
      assert.match(err.message, /^npm did not finish within 1\.5 s/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  const { pid } = JSON.parse(fs.readFileSync(log, "utf8"));
  if (WIN) assert.equal(alive(pid), false, "taskkill ended the npm cmd.exe started");
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [], "no temporary folder left");
});
