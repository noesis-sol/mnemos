// A text's vector must not depend on the texts it is embedded with. The real
// q8 model quantizes its activations with one scale per tensor, over the whole
// padded batch, so batching moved scores by up to 0.017. The stand-in model
// here does the same: each token's vector is rounded to a step set by the
// largest value anywhere in the batch, padding included.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_DIM, ModelEmbedder } from "../dist/embedder.js";

/** Token values: a word's length, then 1; padding tokens get 100, as real padding gets its own activations. */
function quantizingStandIn() {
  const tokenizer = (texts, { padding }) => {
    const words = texts.map((t) => t.split(" "));
    const tokens = padding ? Math.max(...words.map((w) => w.length)) : words[0].length;
    if (!padding) assert.equal(texts.length, 1, "unpadded runs hold one text");
    const ids = new BigInt64Array(texts.length * tokens);
    const mask = new BigInt64Array(texts.length * tokens);
    words.forEach((w, i) =>
      w.forEach((word, t) => {
        ids[i * tokens + t] = BigInt(word.length);
        mask[i * tokens + t] = 1n;
      }),
    );
    return {
      input_ids: { data: ids, dims: [texts.length, tokens] },
      attention_mask: { data: mask, dims: [texts.length, tokens] },
    };
  };
  const model = async ({ input_ids, attention_mask }) => {
    const [count, tokens] = input_ids.dims;
    const raw = new Float32Array(count * tokens * MODEL_DIM);
    for (let k = 0; k < count * tokens; k++) {
      const pad = attention_mask.data[k] === 0n;
      raw[k * MODEL_DIM] = pad ? 100 : Number(input_ids.data[k]);
      raw[k * MODEL_DIM + 1] = pad ? 100 : 1;
    }
    const step = Math.max(...raw) / 7;
    return { last_hidden_state: { data: raw.map((v) => Math.round(v / step) * step), dims: [count, tokens, MODEL_DIM] } };
  };
  return {
    env: {},
    AutoTokenizer: { from_pretrained: async () => tokenizer },
    AutoModel: { from_pretrained: async () => model },
  };
}

test("embed: a text's vector is the same alone and beside other texts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-embed-batch-"));
  try {
    const lib = quantizingStandIn();
    const embedder = new ModelEmbedder({ dir, importTransformers: async () => lib });
    const text = "olive oil is pressed";
    const [alone] = await embedder.embed([text], "passage");
    const besideLonger = await embedder.embed(
      ["extraordinarily long words throughout this particular sentence here", text],
      "passage",
    );
    const besideShorter = await embedder.embed([text, "a b"], "passage");
    assert.deepEqual(Array.from(besideLonger[1]), Array.from(alone));
    assert.deepEqual(Array.from(besideShorter[0]), Array.from(alone));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
