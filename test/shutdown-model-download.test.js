// Stopping the model's download at shutdown. On a first start the embedder
// downloads about 135 MB from Hugging Face, and the library takes no
// AbortSignal: ModelEmbedder gives its fetches (env.fetch) one, which close()
// aborts, so a client that closes stdin mid-download does not leave mnemos
// downloading. Never the real library or network: a stand-in whose
// from_pretrained reads, through env.fetch, a local response that sends a
// little and then stalls, keeping its socket (and the process) alive. In
// process (dist/embedder.js) and over MCP (the built server, spawned with a
// --import resolve hook that puts the stand-in in the library's place).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EmbedderUnavailableError, MODEL_DIM, ModelEmbedder, SHUTTING_DOWN, configureTransformers } from "../dist/embedder.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

let root;
let server;
let url;
/** Requests the stalling server has had, and how many of their sockets have closed since. */
const seen = { requests: 0, closed: 0 };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-download-"));
  server = http.createServer((req, res) => {
    seen.requests++;
    req.socket.once("close", () => seen.closed++);
    // A model file that starts to come in, then stalls for good.
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(135_000_000) });
    res.write(Buffer.alloc(64 * 1024));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/model_quantized.onnx`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

let n = 0;
function freshDir() {
  return path.join(root, `case-${++n}`);
}

async function until(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The stand-in library's source: from_pretrained downloads `url` through env.fetch, as the library does. */
function standInSource(urlExpression) {
  return `export const env = {};
const tokenizer = (texts) => ({ attention_mask: { data: new BigInt64Array(texts.length).fill(1n), dims: [texts.length, 1] } });
const model = async (inputs) => {
  const [count] = inputs.attention_mask.dims;
  const data = new Float32Array(count * ${MODEL_DIM});
  for (let i = 0; i < count; i++) data[i * ${MODEL_DIM}] = 1;
  return { last_hidden_state: { data, dims: [count, 1, ${MODEL_DIM}] } };
};
async function download() {
  const response = await env.fetch(${urlExpression}, { headers: new Headers() });
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
}
export const AutoTokenizer = { from_pretrained: async () => { await download(); return tokenizer; } };
export const AutoModel = { from_pretrained: async () => { await download(); return model; } };
`;
}

/** Imports a stand-in library written into `dir`. */
async function standIn(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "stand-in.mjs");
  fs.writeFileSync(file, standInSource(JSON.stringify(url)));
  return import(pathToFileURL(file).href);
}

test("close(): aborts the download in progress, and the load and every later embed() reject", async () => {
  const dir = freshDir();
  const lib = await standIn(path.join(dir, "lib"));
  let imports = 0;
  const embedder = new ModelEmbedder({
    dir,
    importTransformers: async () => {
      imports++;
      return lib;
    },
  });
  const requests = seen.requests;
  const closed = seen.closed;
  const embedding = embedder.embed(["hello"], "query").then(
    () => assert.fail("the download should not finish"),
    (err) => err,
  );
  await until(() => seen.requests > requests, "the download to start");
  assert.equal(embedder.status().state, "downloading");
  const closing = Date.now();
  embedder.close();
  const err = await embedding;
  assert.ok(err instanceof EmbedderUnavailableError, String(err));
  assert.equal(err.reason, SHUTTING_DOWN);
  assert.ok(Date.now() - closing < 2_000, `took ${Date.now() - closing} ms`);
  await until(() => seen.closed > closed, "the download's connection to close");
  assert.deepEqual(embedder.status(), { state: "unavailable", reason: SHUTTING_DOWN }, "never retried");
  await assert.rejects(embedder.embed(["again"], "query"), (e) => e instanceof EmbedderUnavailableError && e.reason === SHUTTING_DOWN);
  assert.equal(imports, 1, "no load after close()");
  assert.equal(seen.requests, requests + 1, "no download after close()");
});

test("close(): before any load, embed() rejects without loading the library", async () => {
  let imports = 0;
  const embedder = new ModelEmbedder({
    dir: freshDir(),
    importTransformers: async () => {
      imports++;
      throw new Error("not loaded");
    },
  });
  embedder.close();
  await assert.rejects(embedder.embed(["hello"], "query"), (e) => e instanceof EmbedderUnavailableError && e.reason === SHUTTING_DOWN);
  assert.equal(imports, 0);
  assert.deepEqual(embedder.status(), { state: "unavailable", reason: SHUTTING_DOWN });
});

test("configureTransformers: with a signal, the library's fetches get it, and keep a signal of their own", async () => {
  const env = {};
  const controller = new AbortController();
  configureTransformers(env, freshDir(), true, controller.signal);
  const own = new AbortController();
  own.abort();
  await assert.rejects(env.fetch(url, { signal: own.signal }), { name: "AbortError" }, "the caller's own signal still counts");
  const response = await env.fetch(url, { headers: new Headers() });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(
    (async () => {
      while (!(await reader.read()).done) {}
    })(),
    { name: "AbortError" },
    "the body stops coming in too",
  );
  const unconfigured = {};
  configureTransformers(unconfigured, freshDir(), true);
  assert.equal(unconfigured.fetch, undefined, "no signal: the library's own fetch");
});

test("configureTransformers: wraps the library's own fetch, once however often it is called", async () => {
  const calls = [];
  const own = async (input, init) => {
    calls.push({ input: String(input), signal: init.signal });
    return new Response("ok");
  };
  const env = { fetch: own };
  const first = new AbortController();
  const second = new AbortController();
  configureTransformers(env, freshDir(), true, first.signal);
  configureTransformers(env, freshDir(), true, second.signal);
  assert.notEqual(env.fetch, own);
  assert.equal(await (await env.fetch("https://huggingface.co/x")).text(), "ok");
  assert.equal(calls.length, 1, "the env's fetch, called once: no wrapper around a wrapper");
  assert.equal(calls[0].input, "https://huggingface.co/x");
  assert.equal(calls[0].signal, second.signal, "the latest signal");
});

/** Writes a module that, preloaded with --import, resolves @huggingface/transformers to the stand-in. */
function replaceTransformers(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lib = path.join(dir, "stand-in.mjs");
  fs.writeFileSync(lib, standInSource("process.env.MNEMOS_TEST_MODEL_URL"));
  const hooks = path.join(dir, "hooks.mjs");
  fs.writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
  if (specifier === "@huggingface/transformers") return { url: ${JSON.stringify(pathToFileURL(lib).href)}, shortCircuit: true };
  return next(specifier, context);
}
`,
  );
  const register = path.join(dir, "register.mjs");
  fs.writeFileSync(register, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  return register;
}

test("e2e: closing stdin mid-download stops the download, and the server exits", { timeout: 60_000 }, async () => {
  const dir = freshDir();
  const register = replaceTransformers(path.join(dir, "hook"));
  const requests = seen.requests;
  const child = spawn(process.execPath, ["--import", pathToFileURL(register).href, path.join(ROOT, "dist", "index.js")], {
    env: {
      ...process.env,
      CHROME_BOOKMARKS_PATH: FIXTURE,
      MNEMOS_CACHE_DIR: path.join(dir, "cache"),
      MNEMOS_EMBEDDER: "",
      MNEMOS_FETCH_PAGES: "0",
      MNEMOS_INSTALL_RUNTIME: "0",
      MNEMOS_TEST_MODEL_URL: url,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mnemos-download", version: "0.0.0" } },
      }) + "\n",
    );
    // The indexer's first titles need the model: its download starts, and stalls.
    await until(() => seen.requests > requests, "the model download to start", 30_000);
    const closing = Date.now();
    child.stdin.end();
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000).unref())]);
    assert.deepEqual(result, { code: 0, signal: null }, "the server exits once the client is gone");
    const took = Date.now() - closing;
    assert.ok(took < 3_000, `took ${took} ms to exit`);
  } finally {
    child.kill("SIGKILL");
  }
});
