// The embedding runtime (runtime.ts): @huggingface/transformers is not a
// dependency of mnemos-mcp, so a cold `npx -y mnemos-mcp` stays quick; the
// first time the embedder needs it, mnemos installs it with npm into
// <cache dir>/runtime. These tests run the real npm, offline: what it installs
// is a stand-in package in a temporary folder (a file: spec), never the real
// library.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedderUnavailableError, MODEL_DIM, ModelEmbedder, RETRY_MIN_MS } from "../dist/embedder.js";
import {
  RuntimeInstallError,
  TRANSFORMERS,
  TRANSFORMERS_VERSION,
  loadTransformers,
  npmCommand,
  npmEnv,
  runtimeDir,
  runtimeFolder,
} from "../dist/runtime.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let root;
let standIn; // a file: spec for the stand-in package

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-runtime-"));
  const pkg = path.join(root, "stand-in");
  fs.mkdirSync(pkg);
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: TRANSFORMERS, version: TRANSFORMERS_VERSION, type: "module", exports: "./index.js" }),
  );
  // Enough of the library for ModelEmbedder: every token vector is the first unit vector.
  fs.writeFileSync(
    path.join(pkg, "index.js"),
    `export const STAND_IN = true;
export const env = {};
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
  standIn = `file:${pkg}`;
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

test("package: @huggingface/transformers is no dependency, and the dev copy is the version installed", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies?.[TRANSFORMERS], undefined);
  assert.equal(pkg.optionalDependencies?.[TRANSFORMERS], undefined, "npx would install its 488 MB before the handshake");
  assert.equal(pkg.devDependencies?.[TRANSFORMERS], TRANSFORMERS_VERSION);
});

test("install: a missing library is installed into <cache dir>/runtime with npm and imported from there", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  let installs = 0;
  const lib = await loadTransformers({ dir, spec: standIn, importBeside: missing, onInstall: () => installs++ });
  assert.equal(lib.STAND_IN, true);
  assert.equal(installs, 1);
  const folder = path.join(runtimeDir(dir), runtimeFolder(standIn));
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, { [TRANSFORMERS]: standIn });
  assert.ok(fs.existsSync(path.join(folder, "node_modules", ...TRANSFORMERS.split("/"), "package.json")));
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(standIn)], "no temporary folder left");

  // A later start imports what is there and runs no npm.
  const again = await loadTransformers({ dir, spec: standIn, importBeside: missing, onInstall: () => installs++ });
  assert.equal(again.STAND_IN, true);
  assert.equal(installs, 1);
});

test("install: the default spec is the pinned version, in its own folder", () => {
  assert.equal(runtimeFolder(TRANSFORMERS_VERSION), `transformers-${TRANSFORMERS_VERSION}`);
  assert.notEqual(runtimeFolder(standIn), runtimeFolder(TRANSFORMERS_VERSION));
});

test("install: the library beside mnemos is used as it is, and nothing is installed", async () => {
  const dir = freshDir();
  const beside = { beside: true };
  let installs = 0;
  assert.equal(await loadTransformers({ dir, spec: standIn, importBeside: async () => beside, onInstall: () => installs++ }), beside);
  assert.equal(installs, 0);
  assert.equal(fs.existsSync(runtimeDir(dir)), false);
});

test("install: with installing off, a missing library rejects with the import's error and nothing is written", async () => {
  const dir = freshDir();
  await assert.rejects(loadTransformers({ dir, spec: standIn, importBeside: missing, install: false }), /Cannot find package/);
  assert.equal(fs.existsSync(runtimeDir(dir)), false);
});

test("install: npm failing rejects with RuntimeInstallError and npm's message, leaving no temporary folder", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  const spec = `file:${path.join(root, "no-such-package.tgz")}`;
  await assert.rejects(loadTransformers({ dir, spec, importBeside: missing }), (err) => {
    assert.ok(err instanceof RuntimeInstallError, String(err));
    assert.match(err.message, /npm install failed/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), []);
});

test("install: two installs at once both load, into one runtime folder", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  const [a, b] = await Promise.all([
    loadTransformers({ dir, spec: standIn, importBeside: missing }),
    loadTransformers({ dir, spec: standIn, importBeside: missing }),
  ]);
  assert.equal(a.STAND_IN, true);
  assert.equal(b.STAND_IN, true);
  assert.deepEqual(fs.readdirSync(runtimeDir(dir)), [runtimeFolder(standIn)]);
});

test("install: removes a dead process's temporary folder and other versions' runtimes, not a recent install", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  const runtime = runtimeDir(dir);
  for (const name of [".install-dead", ".install-running", "transformers-4.0.0"]) {
    fs.mkdirSync(path.join(runtime, name, "node_modules"), { recursive: true });
  }
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  fs.utimesSync(path.join(runtime, ".install-dead"), old, old);
  await loadTransformers({ dir, spec: standIn, importBeside: missing });
  assert.deepEqual(fs.readdirSync(runtime).sort(), [".install-running", runtimeFolder(standIn)].sort());
});

test("embedder: reports installing, then embeds through the installed runtime", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  const seen = [];
  const embedder = new ModelEmbedder({
    dir,
    importTransformers: (onInstall) =>
      loadTransformers({
        dir,
        spec: standIn,
        importBeside: missing,
        onInstall: () => {
          onInstall();
          seen.push(embedder.status());
        },
      }),
  });
  const [vector] = await embedder.embed(["hello"], "query");
  assert.deepEqual(seen, [{ state: "installing" }]);
  assert.deepEqual(embedder.status(), { state: "ready" });
  assert.equal(vector.length, MODEL_DIM);
  assert.equal(vector[0], 1);
});

test("embedder: a failed install is retried after the backoff, not before", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  let now = 1_000;
  let spec = `file:${path.join(root, "no-such-package.tgz")}`;
  let installs = 0;
  const embedder = new ModelEmbedder({
    dir,
    now: () => now,
    importTransformers: (onInstall) =>
      loadTransformers({
        dir,
        spec,
        importBeside: missing,
        onInstall: () => {
          installs++;
          onInstall();
        },
      }),
  });
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  const status = embedder.status();
  assert.equal(status.state, "unavailable");
  assert.match(status.reason, /could not be installed: npm install failed/);
  assert.equal(status.retry_at, now + RETRY_MIN_MS);

  spec = standIn; // the network is back
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  assert.equal(installs, 1, "not before retry_at");
  now += RETRY_MIN_MS;
  const [vector] = await embedder.embed(["x"], "query");
  assert.equal(installs, 2);
  assert.equal(vector.length, MODEL_DIM);
  assert.deepEqual(embedder.status(), { state: "ready" });
});

test("npm: npx's own npm first, then the npm beside node, then npm on the PATH", () => {
  const all = () => true;
  const none = () => false;
  assert.deepEqual(npmCommand({ npm_execpath: "/n/lib/node_modules/npm/bin/npx-cli.js" }, "/n/bin/node", "darwin", all), {
    command: "/n/bin/node",
    args: ["/n/lib/node_modules/npm/bin/npm-cli.js"],
    shell: false,
  });
  // Not npm's (yarn, pnpm): skipped.
  assert.deepEqual(npmCommand({ npm_execpath: "/y/yarn.js" }, "/n/bin/node", "linux", all).args, [
    "/n/lib/node_modules/npm/bin/npm-cli.js",
  ]);
  assert.deepEqual(npmCommand({}, "C:\\node\\node.exe", "win32", all), {
    command: "C:\\node\\node.exe",
    args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js"],
    shell: false,
  });
  assert.deepEqual(npmCommand({}, "/n/bin/node", "linux", none), { command: "npm", args: [], shell: false });
  assert.deepEqual(npmCommand({}, "C:\\node\\node.exe", "win32", none), { command: "npm.cmd", args: [], shell: true });
});

test("npm: runs without what npx sets for the command it runs, keeping the user's npm config", () => {
  const env = npmEnv({
    PATH: "/bin",
    npm_execpath: "/n/npm-cli.js",
    npm_package_json: "/home/u/package.json",
    npm_lifecycle_event: "npx",
    npm_command: "exec",
    npm_config_local_prefix: "/home/u",
    npm_config_prefix: "/n",
    npm_config_call: "mnemos-mcp",
    NPM_CONFIG_GLOBAL: "true",
    npm_config_registry: "https://registry.example/",
    npm_config_https_proxy: "http://proxy:3128",
    npm_config_cache: "/home/u/.npm",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    npm_config_registry: "https://registry.example/",
    npm_config_https_proxy: "http://proxy:3128",
    npm_config_cache: "/home/u/.npm",
  });
});
