// The runtime install's last resorts (runtime.ts): npm stopped after the
// install's timeout, and npm on the PATH run when there is none beside node.
// Offline: the npm run is a stub on the PATH, a node script that either never
// exits or lays out a stand-in package as npm would, and the node it is looked
// for beside (execPath) has no npm-cli.js.
//
// The timeout is skipped on Windows: npm on the PATH is npm.cmd, run through
// cmd.exe, and killing cmd.exe leaves the npm it started holding the output
// pipes (mnemos-abn).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeInstallError, TRANSFORMERS, TRANSFORMERS_VERSION, loadTransformers, runtimeDir, runtimeFolder } from "../dist/runtime.js";

let root;
let bin; // holds the stub npm
let noNpm; // a node with no npm beside it
let standIn; // the stand-in package the stub installs

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-runtime-npm-"));
  standIn = path.join(root, "stand-in");
  fs.mkdirSync(standIn);
  fs.writeFileSync(
    path.join(standIn, "package.json"),
    JSON.stringify({ name: TRANSFORMERS, version: TRANSFORMERS_VERSION, type: "module", exports: "./index.js" }),
  );
  fs.writeFileSync(path.join(standIn, "index.js"), "export const STAND_IN = true;\n");

  bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stub = path.join(root, "npm-stub.mjs");
  // Records its pid and arguments, then hangs or installs the stand-in into node_modules.
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.STUB_MODE === "hang") {
  setInterval(() => {}, 60_000);
} else {
  fs.cpSync(process.env.STUB_PACKAGE, path.join("node_modules", ...${JSON.stringify(TRANSFORMERS.split("/"))}), { recursive: true });
}
`,
  );
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "npm.cmd"), `@"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    // exec: the stub is the process mnemos spawned, so its pid is the one killed.
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  }
  noNpm = path.join(root, "no-npm", "bin", process.platform === "win32" ? "node.exe" : "node");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

let n = 0;
function freshDir() {
  return path.join(root, `case-${++n}`);
}

const missing = async () => {
  throw new Error(`Cannot find package '${TRANSFORMERS}' (test)`);
};

/** mnemos's environment with the stub first on the PATH, and no npx npm to prefer. */
function stubEnv(mode, log) {
  const env = { ...process.env, STUB_MODE: mode, STUB_LOG: log, STUB_PACKAGE: standIn };
  delete env.npm_execpath;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${bin}${path.delimiter}${env[key] ?? ""}`;
  return env;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

test(
  "timeout: an npm that never exits is killed, rejecting with RuntimeInstallError and leaving no temporary folder",
  { skip: process.platform === "win32" && "killing npm.cmd's cmd.exe leaves npm running (mnemos-abn)", timeout: 30_000 },
  async () => {
    const dir = freshDir();
    const log = path.join(root, `stub-${n}.json`);
    const started = Date.now();
    await assert.rejects(
      loadTransformers({ dir, spec: TRANSFORMERS_VERSION, importBeside: missing, env: stubEnv("hang", log), execPath: noNpm, timeoutMs: 1500 }),
      (err) => {
        assert.ok(err instanceof RuntimeInstallError, String(err));
        assert.match(err.message, /^npm did not finish within 1\.5 s/);
        return true;
      },
    );
    assert.ok(Date.now() - started >= 1500, "not before the timeout");
    const { pid } = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(alive(pid), false, "the stub npm was killed");
    assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [], "no temporary folder left");
  },
);

test("npm on the PATH: with no npm beside node, the one on the PATH installs the runtime, which is imported", { timeout: 30_000 }, async () => {
  const dir = freshDir();
  const log = path.join(root, `stub-${n}.json`);
  const spec = TRANSFORMERS_VERSION;
  const lib = await loadTransformers({ dir, spec, importBeside: missing, env: stubEnv("install", log), execPath: noNpm });
  assert.equal(lib.STAND_IN, true);
  const run = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(run.args[0], "install");
  assert.ok(run.args.includes("--ignore-scripts"), run.args.join(" "));
  assert.equal(path.basename(path.dirname(run.cwd)), "runtime", "run in a temporary folder in <cache dir>/runtime");
  const folder = path.join(runtimeDir(dir), runtimeFolder(spec));
  assert.ok(fs.existsSync(path.join(folder, "node_modules", ...TRANSFORMERS.split("/"), "index.js")));
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(spec)], "no temporary folder left");
});
