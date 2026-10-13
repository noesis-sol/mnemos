// Unit tests for the embedder (embedder.ts). None loads the real model or
// touches the network: the library is replaced by a stand-in, or its import
// is made to fail. The real model has an opt-in smoke test, e2e/model.e2e.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BATCH_SIZE,
  EmbedderUnavailableError,
  FakeEmbedder,
  MODEL_DIM,
  MODEL_FILES,
  MODEL_ID,
  MODEL_REVISION,
  ModelEmbedder,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  createEmbedder,
  fakeVector,
  meanPool,
  modelsDir,
} from "../dist/embedder.js";
import { dot } from "../dist/index-store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-embedder-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
function freshDir() {
  return path.join(root, `case-${++n}`);
}

function norm(v) {
  return Math.sqrt(dot(v, v));
}

/**
 * A stand-in for @huggingface/transformers: records what it is asked for,
 * and its "model" returns, for each text, token vectors [i + 1, 0, ...] so
 * every pooled vector is the first unit vector.
 */
function standIn({ failLoads = 0, onLoad } = {}) {
  const calls = { tokenizer: [], model: [], batches: [], loads: 0 };
  const tokenizer = (texts, options) => {
    calls.batches.push(texts);
    const tokens = 2;
    return {
      input_ids: { data: new BigInt64Array(texts.length * tokens), dims: [texts.length, tokens] },
      attention_mask: { data: new BigInt64Array(texts.length * tokens).fill(1n), dims: [texts.length, tokens] },
      options,
    };
  };
  const model = async (inputs) => {
    const [count, tokens] = inputs.attention_mask.dims;
    const data = new Float32Array(count * tokens * MODEL_DIM);
    for (let i = 0; i < count * tokens; i++) data[i * MODEL_DIM] = i + 1;
    return { last_hidden_state: { data, dims: [count, tokens, MODEL_DIM] } };
  };
  const lib = {
    env: {},
    AutoTokenizer: {
      async from_pretrained(id, options) {
        calls.loads++;
        calls.tokenizer.push({ id, options, env: { ...lib.env } });
        if (calls.loads <= failLoads) throw new Error(`network down (${calls.loads})`);
        await onLoad?.(options);
        return tokenizer;
      },
    },
    AutoModel: {
      async from_pretrained(id, options) {
        calls.model.push({ id, options, env: { ...lib.env } });
        return model;
      },
    },
  };
  return { lib, calls };
}

// --- the fake embedder ------------------------------------------------------

test("fake: MNEMOS_EMBEDDER=fake selects it; anything else the real model, not yet loaded", () => {
  assert.ok(createEmbedder({ MNEMOS_EMBEDDER: "fake" }) instanceof FakeEmbedder);
  for (const env of [{}, { MNEMOS_EMBEDDER: "" }, { MNEMOS_EMBEDDER: "model" }]) {
    const embedder = createEmbedder({ ...env, MNEMOS_CACHE_DIR: freshDir() });
    assert.ok(embedder instanceof ModelEmbedder);
    assert.deepEqual(embedder.status(), { state: "not_started" });
  }
});

test("fake: deterministic, 384 dims, normalised, ready, kind ignored", async () => {
  const fake = new FakeEmbedder();
  assert.equal(fake.dim, 384);
  assert.deepEqual(fake.status(), { state: "ready" });
  const [a] = await fake.embed(["Rust async runtimes"], "passage");
  const [b] = await new FakeEmbedder().embed(["Rust async runtimes"], "query");
  assert.equal(a.length, 384);
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
  assert.ok(Math.abs(norm(a) - 1) < 1e-6);
  assert.deepEqual(fakeVector("Rust async runtimes"), a);
});

test("fake: texts sharing words are similar; texts sharing none are not", async () => {
  const [query, near, nearer, far] = await new FakeEmbedder().embed(
    ["kubernetes networking", "Kubernetes storage", "KUBERNETES networking guide", "sourdough bread recipe"],
    "passage",
  );
  assert.ok(dot(query, near) > 0.4, `shared word: ${dot(query, near)}`);
  assert.ok(dot(query, nearer) > dot(query, near), "more shared words score higher");
  assert.equal(dot(query, far), 0);
});

test("fake: words are letters and digits in any script; no words gives a zero vector", () => {
  assert.ok(dot(fakeVector("Συνταγή για ψωμί"), fakeVector("ψωμί, προζύμι")) > 0.3);
  assert.deepEqual(fakeVector("c++ (2024)"), fakeVector("C 2024"));
  assert.ok(fakeVector(" -- ").every((x) => x === 0));
});

// --- dependency absent ------------------------------------------------------

test("absent: an import that fails makes the embedder unavailable for good, with the reason", async () => {
  let imports = 0;
  let now = 0;
  const embedder = new ModelEmbedder({
    dir: freshDir(),
    now: () => now,
    importTransformers: async () => {
      imports++;
      throw new Error("Cannot find package '@huggingface/transformers'");
    },
  });
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  const status = embedder.status();
  assert.equal(status.state, "unavailable");
  assert.match(status.reason, /@huggingface\/transformers.*Cannot find package/);
  assert.equal(status.retry_at, undefined);
  now += RETRY_MAX_MS * 10;
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  assert.equal(imports, 1, "a missing library is not retried");
});

/** Writes a module that, preloaded with --import, makes @huggingface/transformers unresolvable. */
function blockTransformers(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hooks = path.join(dir, "hooks.mjs");
  fs.writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
  if (specifier === "@huggingface/transformers" || specifier.startsWith("@huggingface/transformers/")) {
    throw Object.assign(new Error("Cannot find package '@huggingface/transformers' (blocked by test)"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  }
  return next(specifier, context);
}
`,
  );
  const register = path.join(dir, "register.mjs");
  fs.writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
  );
  return register;
}

test("absent: with the package unresolvable, the real import fails and the embedder reports unavailable", () => {
  const dir = freshDir();
  const register = blockTransformers(path.join(dir, "hook"));
  const script = `
    import { createEmbedder } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "dist", "embedder.js")).href)};
    const embedder = createEmbedder({ MNEMOS_CACHE_DIR: ${JSON.stringify(dir)} });
    const before = embedder.status();
    const error = await embedder.embed(["hello"], "query").then(() => null, (e) => e.name);
    console.log(JSON.stringify({ before, error, after: embedder.status() }));
  `;
  const out = execFileSync(process.execPath, ["--import", pathToFileURL(register).href, "--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { before, error, after } = JSON.parse(out);
  assert.deepEqual(before, { state: "not_started" });
  assert.equal(error, "EmbedderUnavailableError");
  assert.equal(after.state, "unavailable");
  assert.match(after.reason, /blocked by test/);
  assert.equal(fs.existsSync(modelsDir(dir)), false, "nothing written to the models folder");
});

test("absent: with the package unresolvable, the server still starts and answers", async () => {
  const dir = freshDir();
  const register = blockTransformers(path.join(dir, "hook"));
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", pathToFileURL(register).href, path.join(ROOT, "dist", "index.js")],
      env: { ...process.env, CHROME_BOOKMARKS_PATH: FIXTURE, MNEMOS_CACHE_DIR: dir, MNEMOS_FETCH_PAGES: "0" },
      stderr: "ignore",
    }),
  );
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 5);
    const result = await client.callTool({ name: "search_bookmarks", arguments: { query: "openai" } });
    assert.equal(JSON.parse(result.content[0].text).total_matches, 1);
  } finally {
    await client.close();
  }
});

// --- where the model comes from ---------------------------------------------

test("config: first use downloads the pinned revision into <cache dir>/models", async () => {
  const dir = freshDir();
  const { lib, calls } = standIn();
  const embedder = new ModelEmbedder({ dir, importTransformers: async () => lib });
  assert.equal(embedder.modelDir, path.join(dir, "models", "Xenova", "multilingual-e5-small", MODEL_REVISION));
  await embedder.embed(["hello"], "query");

  assert.equal(lib.env.cacheDir, path.join(dir, "models"));
  assert.equal(lib.env.useFSCache, true);
  assert.equal(lib.env.allowRemoteModels, true);
  assert.equal(lib.env.localModelPath, path.join(dir, "models") + path.sep);
  assert.equal(lib.env.logLevel, 40, "errors only: transformers logs info to stdout, the MCP channel");
  for (const call of [calls.tokenizer[0], calls.model[0]]) {
    assert.equal(call.id, MODEL_ID);
    assert.equal(call.options.revision, MODEL_REVISION);
    assert.equal(call.env.cacheDir, path.join(dir, "models"), "configured before loading");
  }
  assert.equal(MODEL_ID, "Xenova/multilingual-e5-small");
  assert.equal(MODEL_REVISION, "761b726dd34fb83930e26aab4e9ac3899aa1fa78");
  assert.equal(calls.model[0].options.dtype, "q8");
  assert.deepEqual(embedder.status(), { state: "ready" });
});

test("config: once downloaded, the revision folder is loaded locally with remote access off", async () => {
  const dir = freshDir();
  const { lib, calls } = standIn();
  const embedder = new ModelEmbedder({ dir, importTransformers: async () => lib });
  for (const file of MODEL_FILES) {
    fs.mkdirSync(path.dirname(path.join(embedder.modelDir, file)), { recursive: true });
    fs.writeFileSync(path.join(embedder.modelDir, file), "");
  }
  await embedder.embed(["hello"], "query");
  assert.equal(lib.env.allowRemoteModels, false);
  assert.equal(lib.env.cacheDir, path.join(dir, "models"));
  for (const call of [calls.tokenizer[0], calls.model[0]]) {
    assert.equal(call.id, `${MODEL_ID}/${MODEL_REVISION}`);
    assert.equal(call.env.allowRemoteModels, false);
    assert.equal(call.options.progress_callback, undefined);
  }
  assert.equal(calls.model[0].options.dtype, "q8");
});

test("config: a partial download is completed from the network", async () => {
  const dir = freshDir();
  const { lib, calls } = standIn();
  const embedder = new ModelEmbedder({ dir, importTransformers: async () => lib });
  fs.mkdirSync(embedder.modelDir, { recursive: true });
  fs.writeFileSync(path.join(embedder.modelDir, "config.json"), "{}");
  await embedder.embed(["hello"], "query");
  assert.equal(calls.tokenizer[0].env.allowRemoteModels, true);
  assert.equal(calls.tokenizer[0].options.revision, MODEL_REVISION);
});

// --- embedding --------------------------------------------------------------

test("embed: prefixes by kind, batches by 32 in order, one vector per text", async () => {
  const { lib, calls } = standIn();
  const embedder = new ModelEmbedder({ dir: freshDir(), importTransformers: async () => lib });
  const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
  const vectors = await embedder.embed(texts, "passage");
  assert.equal(BATCH_SIZE, 32);
  assert.deepEqual(
    calls.batches.map((b) => b.length),
    [32, 32, 6],
  );
  assert.deepEqual(calls.batches.flat(), texts.map((t) => `passage: ${t}`));
  assert.equal(vectors.length, 70);
  for (const v of vectors) {
    assert.equal(v.length, MODEL_DIM);
    assert.ok(Math.abs(norm(v) - 1) < 1e-6);
  }
  await embedder.embed(["q"], "query");
  assert.deepEqual(calls.batches.at(-1), ["query: q"]);
  assert.deepEqual(await embedder.embed([], "query"), []);
});

test("embed: yields to the event loop between batches", async () => {
  const { lib, calls } = standIn();
  const embedder = new ModelEmbedder({ dir: freshDir(), importTransformers: async () => lib });
  await embedder.embed(["warm up"], "query");
  calls.batches.length = 0;
  const seen = [];
  const pending = embedder.embed(Array.from({ length: 3 * BATCH_SIZE }, (_, i) => `t${i}`), "passage");
  setImmediate(() => seen.push(calls.batches.length));
  await pending;
  assert.equal(seen.length, 1);
  assert.ok(seen[0] < 3, `an immediate ran after ${seen[0]} of 3 batches`);
});

test("embed: concurrent calls share one load", async () => {
  const { lib, calls } = standIn();
  const embedder = new ModelEmbedder({ dir: freshDir(), importTransformers: async () => lib });
  const [a, b] = await Promise.all([embedder.embed(["a"], "query"), embedder.embed(["b", "c"], "passage")]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  assert.equal(calls.loads, 1);
});

test("meanPool: averages the tokens the mask keeps, then normalises", () => {
  // two texts, three tokens, dim 2; the second text's last token is padding
  const hidden = { data: new Float32Array([1, 0, 3, 0, 2, 0, 0, 1, 0, 3, 9, 9]), dims: [2, 3, 2] };
  const mask = { data: new BigInt64Array([1n, 1n, 1n, 1n, 1n, 0n]), dims: [2, 3] };
  const [a, b] = meanPool(hidden, mask);
  assert.deepEqual(Array.from(a), [1, 0]);
  assert.deepEqual(Array.from(b), [0, 1]);
});

// --- status and retries -----------------------------------------------------

test("status: downloading with summed bytes, then loading, then ready", async () => {
  const seen = [];
  let embedder;
  const { lib } = standIn({
    onLoad: async (options) => {
      const report = (event) => {
        options.progress_callback({ name: MODEL_ID, ...event });
        seen.push(embedder.status());
      };
      report({ status: "initiate", file: "tokenizer.json" });
      report({ status: "initiate", file: "onnx/model_quantized.onnx" });
      report({ status: "progress", file: "tokenizer.json", loaded: 10, total: 20 });
      report({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 5, total: 100 });
      report({ status: "progress_total", loaded: 15, total: 120 });
      report({ status: "done", file: "tokenizer.json" });
      report({ status: "done", file: "onnx/model_quantized.onnx" });
    },
  });
  embedder = new ModelEmbedder({ dir: freshDir(), importTransformers: async () => lib });
  const pending = embedder.embed(["x"], "query");
  assert.equal(embedder.status().state, "loading", "importing");
  await pending;
  assert.deepEqual(seen, [
    { state: "downloading" },
    { state: "downloading" },
    { state: "downloading", loaded: 10, total: 20 },
    { state: "downloading", loaded: 15, total: 120 },
    { state: "downloading", loaded: 15, total: 120 },
    { state: "downloading", loaded: 15, total: 120 },
    { state: "loading" },
  ]);
  assert.deepEqual(embedder.status(), { state: "ready" });
});

test("retry: a failed load waits with doubling backoff, retried on the next need after it", async () => {
  let now = 1_000_000;
  const { lib, calls } = standIn({ failLoads: 2 });
  const embedder = new ModelEmbedder({ dir: freshDir(), now: () => now, importTransformers: async () => lib });

  await assert.rejects(embedder.embed(["x"], "query"), /network down \(1\)/);
  assert.deepEqual(embedder.status(), {
    state: "unavailable",
    reason: "the model could not be loaded: network down (1)",
    retry_at: now + RETRY_MIN_MS,
  });

  // Needs before retry_at fail at once, without trying.
  now += RETRY_MIN_MS - 1;
  await assert.rejects(embedder.embed(["x"], "query"), EmbedderUnavailableError);
  assert.equal(calls.loads, 1);

  now += 1;
  await assert.rejects(embedder.embed(["x"], "query"), /network down \(2\)/);
  assert.equal(calls.loads, 2);
  assert.equal(embedder.status().retry_at, now + 2 * RETRY_MIN_MS);

  now += 2 * RETRY_MIN_MS;
  assert.equal((await embedder.embed(["x"], "query")).length, 1);
  assert.equal(calls.loads, 3);
  assert.deepEqual(embedder.status(), { state: "ready" });
});

test("retry: the backoff stops growing at RETRY_MAX_MS", async () => {
  let now = 0;
  const { lib } = standIn({ failLoads: Infinity });
  const embedder = new ModelEmbedder({ dir: freshDir(), now: () => now, importTransformers: async () => lib });
  for (let i = 0; i < 12; i++) {
    await assert.rejects(embedder.embed(["x"], "query"));
    const wait = embedder.status().retry_at - now;
    assert.equal(wait, Math.min(RETRY_MIN_MS * 2 ** i, RETRY_MAX_MS));
    now += wait;
  }
});
