// The real embedding model, end to end. Opt-in: it downloads about 135 MB
// from Hugging Face, so it is skipped unless MNEMOS_E2E_MODEL=1, and CI never
// sets that. It runs from scripts/check-full.sh (skipped there by default) or
// by hand:
//
//   npm run build && MNEMOS_E2E_MODEL=1 node --test e2e/model.e2e.js
//
// It downloads the pinned model into a fresh cache directory, checks that the
// files land only in <cache dir>/models at the pinned revision, that an English
// query ranks a relevant Greek passage above an unrelated one, and that a
// second embedder loads the cached model with the library's network access cut.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_DIM, MODEL_FILES, MODEL_ID, MODEL_REVISION, ModelEmbedder } from "../dist/embedder.js";
import { dot } from "../dist/index-store.js";

const skip = process.env.MNEMOS_E2E_MODEL === "1" ? false : "set MNEMOS_E2E_MODEL=1 to download and test the real model";

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-model-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root`, relative to it, with / separators. */
function files(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

test("model: downloads the pinned revision and ranks a Greek passage for an English query", { skip, timeout: 600_000 }, async () => {
  const embedder = new ModelEmbedder({ dir });
  assert.deepEqual(embedder.status(), { state: "not_started" });
  const states = new Set();
  const poll = setInterval(() => states.add(embedder.status().state), 50);

  const started = Date.now();
  const [query] = await embedder.embed(["how to bake sourdough bread at home"], "query");
  clearInterval(poll);
  console.log(`download and load: ${Date.now() - started} ms; states seen: ${[...states].join(", ")}`);
  assert.deepEqual(embedder.status(), { state: "ready" });
  assert.ok(states.has("downloading"), "reported the download");

  const prefix = `models/${MODEL_ID}/${MODEL_REVISION}/`;
  assert.deepEqual(files(dir), MODEL_FILES.map((f) => prefix + f).sort());

  const [relevant, unrelated] = await embedder.embed(
    [
      "Συνταγή για σπιτικό ψωμί με προζύμι: ζύμωμα, φούσκωμα και ψήσιμο στο φούρνο",
      "Ο Ολυμπιακός κέρδισε τον Παναθηναϊκό στο ντέρμπι του πρωταθλήματος",
    ],
    "passage",
  );
  for (const v of [query, relevant, unrelated]) {
    assert.equal(v.length, MODEL_DIM);
    assert.ok(Math.abs(dot(v, v) - 1) < 1e-4);
  }
  const good = dot(query, relevant);
  const bad = dot(query, unrelated);
  console.log(`bread ${good.toFixed(3)}, football ${bad.toFixed(3)}`);
  assert.ok(good > bad, `relevant ${good} should beat unrelated ${bad}`);

  const batch = Array.from({ length: 32 }, (_, i) => `Bookmark ${i}: Rust, databases and web development › Programming`);
  const t = Date.now();
  await embedder.embed(batch, "passage");
  console.log(`32-text batch: ${Date.now() - t} ms`);
});

test("model: a text gets the same vector whatever it is embedded with", { skip, timeout: 120_000 }, async () => {
  // The q8 model quantizes activations over the whole padded batch; batched, these texts once moved the score by 0.004-0.011.
  const embedder = new ModelEmbedder({ dir });
  const query = "how is olive oil made";
  const passage = "Το ελαιόλαδο παράγεται με σύνθλιψη των ελιών και διαχωρισμό του λαδιού από το νερό";
  const [q] = await embedder.embed([query], "query");
  const [p] = await embedder.embed([passage], "passage");
  const [, q2] = await embedder.embed(["what are the best hiking trails in the Swiss Alps in late autumn", query], "query");
  const [p2] = await embedder.embed(
    [passage, "A long English passage about the history of the printing press, movable type and the spread of books in Europe"],
    "passage",
  );
  assert.deepEqual(Array.from(q2), Array.from(q));
  assert.deepEqual(Array.from(p2), Array.from(p));
  console.log(`olive oil ${dot(q, p).toFixed(4)}`);
});

test("model: a second start loads from the cache without the network", { skip, timeout: 120_000 }, async () => {
  // Same module instance the embedder imports, so this cuts its fetch.
  const { env } = await import("@huggingface/transformers");
  const realFetch = env.fetch;
  const fetched = [];
  env.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error(`network used: ${url}`);
  };
  try {
    const embedder = new ModelEmbedder({ dir });
    const [vector] = await embedder.embed(["hello"], "query");
    assert.equal(vector.length, MODEL_DIM);
    assert.deepEqual(fetched, []);
    assert.deepEqual(embedder.status(), { state: "ready" });
  } finally {
    env.fetch = realFetch;
  }
});
