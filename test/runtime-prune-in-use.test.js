// A runtime folder pruned while a mnemos still uses it (runtime.ts): a load
// marks the folder it loads from as used, and a running mnemos loads only once.
// One that runs over 30 days without loading again leaves a marker another
// version's mnemos takes for unused, and that one removes the folder under it.
//
// What happens, as these tests record it: the folder is removed; the library
// the running mnemos imported stays in memory and goes on embedding (the real
// one imports onnxruntime-node and sharp when it is imported, so nothing is
// read from the folder later); and should its embedder load again after a
// failure, it finds the runtime missing: with installing off it is
// unavailable for good, saying the library could not be loaded, and with
// installing on it installs the runtime again and gets the library it already
// had (import() keeps a module by its URL). On Windows the real runtime's
// loaded onnxruntime DLL would keep its folder from being renamed, so it would
// be kept; the stand-in here holds no file open, so it is removed there too.
//
// The runtime folders are laid out by hand; the reinstall runs a stub npm on
// the PATH, a node script that lays out the stand-in package as npm would, with
// an execPath that has no npm-cli.js beside it, as in
// runtime-install-timeout.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EmbedderUnavailableError, MODEL_DIM, ModelEmbedder, RETRY_MIN_MS } from "../dist/embedder.js";
import { LAST_USED, TRANSFORMERS, UNUSED_RUNTIME_MS, loadTransformers, runtimeDir, runtimeFolder } from "../dist/runtime.js";

const DAY = 24 * 60 * 60_000;
/** The running mnemos's version, and the newer one that prunes. */
const OLD = "9.9.8-in-use";
const NEW = "9.9.9-in-use";

let root;
let standIn; // the stand-in package, laid into each runtime folder's node_modules
let bin; // holds the stub npm
let noNpm; // a node with no npm beside it

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-runtime-in-use-"));
  standIn = path.join(root, "stand-in");
  fs.mkdirSync(standIn);
  fs.writeFileSync(path.join(standIn, "package.json"), JSON.stringify({ name: TRANSFORMERS, version: "0.0.0", type: "module", exports: "./index.js" }));
  // Enough of the library for ModelEmbedder: every token vector is the first unit vector.
  fs.writeFileSync(
    path.join(standIn, "index.js"),
    `export const env = {};
const tokenizer = (texts) => ({ attention_mask: { data: new BigInt64Array(texts.length).fill(1n), dims: [texts.length, 1] } });
const model = async (inputs) => {
  const [count] = inputs.attention_mask.dims;
  const data = new Float32Array(count * ${MODEL_DIM});
  for (let i = 0; i < count; i++) data[i * ${MODEL_DIM}] = 1;
  return { last_hidden_state: { data, dims: [count, 1, ${MODEL_DIM}] } };
};
export const AutoTokenizer = { from_pretrained: async () => tokenizer };
export const AutoModel = { from_pretrained: async () => model };
`,
  );

  bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stub = path.join(root, "npm-stub.mjs");
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(process.env.STUB_LOG, process.cwd() + "\\n");
fs.cpSync(process.env.STUB_PACKAGE, path.join("node_modules", ...${JSON.stringify(TRANSFORMERS.split("/"))}), { recursive: true });
`,
  );
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "npm.cmd"), `@"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  }
  noNpm = path.join(root, "no-npm", "bin", process.platform === "win32" ? "node.exe" : "node");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

let n = 0;
/** A cache directory with the runtimes for OLD and NEW installed, laid out as an install leaves them. */
function installedDir() {
  const dir = path.join(root, `case-${++n}`);
  for (const spec of [OLD, NEW]) {
    const folder = path.join(runtimeDir(dir), runtimeFolder(spec));
    fs.cpSync(standIn, path.join(folder, "node_modules", ...TRANSFORMERS.split("/")), { recursive: true });
    fs.writeFileSync(path.join(folder, "load.mjs"), `export * from ${JSON.stringify(TRANSFORMERS)};\n`);
  }
  return dir;
}

const missing = async () => {
  throw new Error(`Cannot find package '${TRANSFORMERS}' (test)`);
};

/** mnemos's environment with the stub first on the PATH, and no npx npm to prefer. */
function stubEnv(log) {
  const env = { ...process.env, STUB_LOG: log, STUB_PACKAGE: standIn };
  delete env.npm_execpath;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${bin}${path.delimiter}${env[key] ?? ""}`;
  return env;
}

/**
 * The running mnemos's embedder, on OLD's runtime. Each library it loads goes
 * into `libs`; while `failing.model` is set, the model fails to load, as a
 * download cut off would.
 */
function oldEmbedder(dir, { now, install, env, onInstall = () => {} }) {
  const libs = [];
  const failing = { model: false };
  const embedder = new ModelEmbedder({
    dir,
    now,
    importTransformers: async (onLoaderInstall) => {
      const lib = await loadTransformers({
        dir,
        spec: OLD,
        importBeside: missing,
        install,
        env,
        execPath: noNpm,
        onInstall: () => {
          onInstall();
          onLoaderInstall();
        },
      });
      libs.push(lib);
      if (!failing.model) return lib;
      return { ...lib, AutoModel: { from_pretrained: async () => Promise.reject(new Error("fetch failed (test)")) } };
    },
  });
  return { embedder, libs, failing };
}

/** 31 days on: OLD's marker is as old as a mnemos that never loaded again leaves it, and NEW's mnemos loads. */
async function newVersionLoads(dir) {
  const marker = path.join(runtimeDir(dir), runtimeFolder(OLD), LAST_USED);
  const old = new Date(Date.now() - UNUSED_RUNTIME_MS - DAY);
  fs.utimesSync(marker, old, old);
  await loadTransformers({ dir, spec: NEW, importBeside: missing, install: false });
}

test("in use: another version's load removes the running mnemos's folder, and its library goes on embedding", async () => {
  const dir = installedDir();
  const { embedder, libs } = oldEmbedder(dir, { install: false });
  assert.equal((await embedder.embed(["before"], "query"))[0][0], 1);
  assert.deepEqual(embedder.status(), { state: "ready" });

  await newVersionLoads(dir);
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(NEW)], "the folder in use is removed");

  const [vector] = await embedder.embed(["after"], "query");
  assert.equal(vector.length, MODEL_DIM);
  assert.equal(vector[0], 1);
  assert.deepEqual(embedder.status(), { state: "ready" });
  assert.equal(libs.length, 1, "a ready embedder does not load the library again");
});

test("in use: a load after a failure, with installing off, leaves the embedder unavailable for good, and writes nothing", async () => {
  const dir = installedDir();
  let now = 1_000;
  const { embedder, libs, failing } = oldEmbedder(dir, { now: () => now, install: false });
  failing.model = true;
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  assert.equal(embedder.status().retry_at, now + RETRY_MIN_MS, "the model's failure is retried after the backoff");

  await newVersionLoads(dir);
  failing.model = false;
  now += RETRY_MIN_MS;
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  const status = embedder.status();
  assert.equal(status.state, "unavailable");
  assert.match(status.reason, /could not be loaded: Cannot find package/);
  assert.equal(status.retry_at, undefined, "never retried");
  assert.equal(libs.length, 1);
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(NEW)], "nothing written");

  now += 10 * RETRY_MIN_MS;
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  assert.equal(libs.length, 1, "not tried again");
});

test("in use: a load after a failure, with installing on, installs the runtime again and gets the library it had", { timeout: 30_000 }, async () => {
  const dir = installedDir();
  const log = path.join(root, `stub-${n}.log`);
  let now = 1_000;
  let installs = 0;
  const { embedder, libs, failing } = oldEmbedder(dir, { now: () => now, env: stubEnv(log), onInstall: () => installs++ });
  failing.model = true;
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  assert.equal(installs, 0, "the runtime was there");

  await newVersionLoads(dir);
  failing.model = false;
  now += RETRY_MIN_MS;
  const [vector] = await embedder.embed(["x"], "query");
  assert.equal(vector[0], 1);
  assert.deepEqual(embedder.status(), { state: "ready" });
  assert.equal(installs, 1, "npm ran once");
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
  assert.equal(libs.length, 2);
  assert.equal(libs[1], libs[0], "import() returns the module it already had, by its URL");

  const folder = path.join(runtimeDir(dir), runtimeFolder(OLD));
  assert.ok(fs.existsSync(path.join(folder, "load.mjs")), "the runtime is back");
  assert.ok(Date.now() - fs.statSync(path.join(folder, LAST_USED)).mtimeMs < DAY, "and marked used");
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)).sort(), [runtimeFolder(NEW), runtimeFolder(OLD)].sort());
});
