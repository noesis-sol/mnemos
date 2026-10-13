// Pruning old embedding runtimes (runtime.ts): each version installs into its
// own <cache dir>/runtime/transformers-<version> folder, and another mnemos on
// the machine may still load an older one. So a load marks the folder it loads
// from as used, and removes other versions' folders unused for 30 days. These
// tests lay the runtime folders out by hand, so no npm runs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAST_USED, TRANSFORMERS, UNUSED_RUNTIME_MS, loadTransformers, runtimeDir, runtimeFolder } from "../dist/runtime.js";

const DAY = 24 * 60 * 60_000;
const SPEC = "9.9.9-prune";

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-runtime-prune-"));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

let n = 0;
/** A cache directory whose runtime for SPEC is installed: its loader is a stand-in module. */
function installedDir() {
  const dir = path.join(root, `case-${++n}`);
  const folder = path.join(runtimeDir(dir), runtimeFolder(SPEC));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "load.mjs"), `export const STAND_IN = ${n};\n`);
  return dir;
}

/** Another runtime folder, with its marker (or, with marker false, only its loader) last written `age` ago. */
function otherRuntime(dir, name, age, { marker = true } = {}) {
  const folder = path.join(runtimeDir(dir), name);
  fs.mkdirSync(path.join(folder, "node_modules", ...TRANSFORMERS.split("/")), { recursive: true });
  fs.writeFileSync(path.join(folder, "load.mjs"), "export {};\n");
  const files = [path.join(folder, "load.mjs")];
  if (marker) {
    fs.writeFileSync(path.join(folder, LAST_USED), "");
    files.push(path.join(folder, LAST_USED));
  }
  const when = new Date(Date.now() - age);
  for (const file of [...files, folder]) fs.utimesSync(file, when, when);
  return folder;
}

const missing = async () => {
  throw new Error(`Cannot find package '${TRANSFORMERS}' (test)`);
};

function load(dir) {
  return loadTransformers({ dir, spec: SPEC, importBeside: missing, install: false });
}

test("prune: a load from the cache marks its runtime folder used", async () => {
  const dir = installedDir();
  const marker = path.join(runtimeDir(dir), runtimeFolder(SPEC), LAST_USED);
  assert.equal(fs.existsSync(marker), false, "a runtime installed before markers");
  const lib = await load(dir);
  assert.equal(lib.STAND_IN, n);
  assert.ok(Date.now() - fs.statSync(marker).mtimeMs < DAY);

  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(marker, old, old);
  await load(dir);
  assert.ok(Date.now() - fs.statSync(marker).mtimeMs < DAY, "touched again on the next load");
});

test("prune: another version's runtime unused for 30 days is removed, one used since is kept", async () => {
  const dir = installedDir();
  const runtime = runtimeDir(dir);
  otherRuntime(dir, "transformers-4.0.0", UNUSED_RUNTIME_MS + DAY);
  otherRuntime(dir, "transformers-4.1.0", UNUSED_RUNTIME_MS - DAY);
  // Installed before markers: its loader's age counts.
  otherRuntime(dir, "transformers-4.2.0", UNUSED_RUNTIME_MS + DAY, { marker: false });
  otherRuntime(dir, "transformers-4.2.1", 2 * DAY, { marker: false });
  // Not a runtime folder: left alone, however old.
  otherRuntime(dir, "models", UNUSED_RUNTIME_MS + DAY);
  await load(dir);
  assert.deepEqual(fs.readdirSync(runtime).sort(), ["models", "transformers-4.1.0", "transformers-4.2.1", runtimeFolder(SPEC)].sort());
});

test("prune: the runtime loaded is kept however long it went unused", async () => {
  const dir = installedDir();
  const folder = path.join(runtimeDir(dir), runtimeFolder(SPEC));
  fs.writeFileSync(path.join(folder, LAST_USED), "");
  const old = new Date(Date.now() - 2 * UNUSED_RUNTIME_MS);
  for (const file of [path.join(folder, LAST_USED), path.join(folder, "load.mjs"), folder]) fs.utimesSync(file, old, old);
  assert.equal((await load(dir)).STAND_IN, n);
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(SPEC)]);
});

test("prune: a removal a dead process left half done is finished on the next load", async () => {
  const dir = installedDir();
  // removeUnused renames a folder to .install-<name>-<pid>-<time> before removing it; the folder keeps its old mtime.
  otherRuntime(dir, ".install-transformers-4.0.0-123-456", UNUSED_RUNTIME_MS + DAY);
  await load(dir);
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(SPEC)]);
});

test("prune: with the library beside mnemos, the cache's runtimes are left as they are", async () => {
  const dir = installedDir();
  const old = otherRuntime(dir, "transformers-4.0.0", UNUSED_RUNTIME_MS + DAY);
  await loadTransformers({ dir, spec: SPEC, importBeside: async () => ({}) });
  assert.ok(fs.existsSync(old));
  assert.equal(fs.existsSync(path.join(runtimeDir(dir), runtimeFolder(SPEC), LAST_USED)), false);
});
