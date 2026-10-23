/**
 * The embedder: turns texts into 384-dim vectors for semantic search.
 *
 * The real one runs Xenova/multilingual-e5-small (quantized ONNX) through
 * @huggingface/transformers, imported with import() only when something first
 * needs a vector. It is not a dependency: runtime.ts installs it into
 * <cache dir>/runtime on that first need, after the MCP handshake, so that a
 * cold `npx -y mnemos-mcp` stays within MCP clients' start timeouts. If it
 * cannot be installed or fails to load, mnemos runs on without it: the
 * embedder reports "unavailable" with the reason and callers fall back to
 * keyword search.
 *
 * The model is downloaded on first use into <cache dir>/models, at a pinned
 * revision, through the library's own file cache (env.cacheDir). The library
 * looks up tokenizer_config.json at revision "main" whatever revision it is
 * given (transformers.js 4.3.1, tokenization_utils.js), so once the files are
 * there the model is loaded as a local model from that same folder, with
 * remote access off: no network after the first download.
 *
 * MNEMOS_EMBEDDER=fake selects FakeEmbedder instead. It is for tests only.
 */

import fs from "node:fs";
import path from "node:path";
import { cacheDir, normalize } from "./index-store.js";
import { loadTransformers, RuntimeInstallError, TRANSFORMERS } from "./runtime.js";

export const MODEL_ID = "Xenova/multilingual-e5-small";
/** The model repository's commit, as of 2026-10-13. A new one re-embeds every index. */
export const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const MODEL_DIM = 384;
/** int8 weights, onnx/model_quantized.onnx (about 118 MB). */
export const MODEL_DTYPE = "q8";
/** What the library downloads for the model, relative to its revision folder. */
export const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

/** The wait after the first failed load, doubled after each further failure up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60_000;

export type EmbedKind = "query" | "passage";

/**
 * Which similarities semantic_search keeps: those at or above `floor`, at
 * least `margin` above the median title's (what this query gives the library
 * at large), and within `window` of the best. Each model spreads its scores
 * differently.
 */
export interface Relevance {
  floor: number;
  margin: number;
  window: number;
  /**
   * The number of titles `margin` was calibrated on. The best of N unrelated
   * titles sits further above the median the more there are (about
   * σ·√(2 ln N)), so for a library of N titles the margin is scaled by
   * √(ln N / ln marginTitles); see semantic.ts' relevanceMargin. Absent: the
   * margin is used as it is.
   */
  marginTitles?: number;
}

/**
 * e5 squeezes cosine scores together: a query's median title scores about
 * 0.75-0.80 (lower for Greek queries), its best unrelated one up to about
 * 0.84, and related ones 0.84-0.89. Calibrated by hand on 2026-10-13 against
 * a real library of 2,300 bookmarks: the queries are listed in
 * test/semantic-search.test.js. In the 31 bookmarks of e2e/fixtures/semantic
 * (2026-10-13) the golden queries' bookmarks stand 0.058-0.11 above the
 * median and the best unrelated title 0.039-0.053: the margin scaled to 31
 * titles (0.043) keeps the first and at most one of the second, the unscaled
 * one (0.065) cut 5 of 13.
 */
export const MODEL_RELEVANCE: Relevance = { floor: 0.8, margin: 0.065, window: 0.04, marginTitles: 2300 };

export type EmbedderStatus =
  | { state: "not_started" }
  /** npm is installing the embedding runtime into <cache dir>/runtime (first start only). */
  | { state: "installing" }
  /** Bytes so far and expected, summed over the model's files, when the library reports them. */
  | { state: "downloading"; loaded?: number; total?: number }
  | { state: "loading" }
  | { state: "ready" }
  /** retry_at (ms since the epoch): when the next need tries again; absent if it never will. */
  | { state: "unavailable"; reason: string; retry_at?: number };

export interface Embedder {
  readonly id: string;
  readonly revision: string;
  readonly dim: number;
  readonly relevance: Relevance;
  /** One normalised vector per text, in order. Rejects with EmbedderUnavailableError while unavailable. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
  status(): EmbedderStatus;
  /** Shutdown: aborts a model download in progress, and has every later embed() reject. */
  close(): void;
}

export class EmbedderUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`embedder unavailable: ${reason}`);
    this.name = "EmbedderUnavailableError";
  }
}

/** The models folder in mnemos's cache directory. */
export function modelsDir(dir: string = cacheDir()): string {
  return path.join(dir, "models");
}

// --- the real model ----------------------------------------------------------

/** The part of @huggingface/transformers this file uses. */
export interface Transformers {
  env: Record<string, unknown>;
  AutoTokenizer: { from_pretrained(id: string, options: Record<string, unknown>): Promise<Tokenizer> };
  AutoModel: { from_pretrained(id: string, options: Record<string, unknown>): Promise<Model> };
}

export interface TensorLike {
  data: ArrayLike<number | bigint>;
  dims: number[];
}

type Tokenizer = (
  texts: string[],
  options: { padding: boolean; truncation: boolean },
) => { attention_mask: TensorLike } & Record<string, unknown>;

type Model = ((inputs: Record<string, unknown>) => Promise<{ last_hidden_state: TensorLike }>) & {
  dispose?: () => Promise<unknown>;
};

export interface ModelEmbedderOptions {
  /** mnemos's cache directory; the model goes into its models folder. Defaults to cacheDir(). */
  dir?: string;
  /**
   * Loads the library, calling `onInstall` if it has to be installed first;
   * tests pass one that fails, or a stand-in. Defaults to runtime.ts'
   * loadTransformers.
   */
  importTransformers?: (onInstall: () => void) => Promise<Transformers>;
  /** false: never install the runtime (MNEMOS_INSTALL_RUNTIME=0). */
  installRuntime?: boolean;
  /** Clock in ms since the epoch, for tests. */
  now?: () => number;
}

/** transformers' logger writes info to stdout, which is the MCP channel: errors only, and those go to stderr. */
const LOG_LEVEL_ERROR = 40;

/** Why embed() rejects once the embedder is closed. */
export const SHUTTING_DOWN = "mnemos is shutting down";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** The fetch each of configureTransformers' wrappers calls, so a later call wraps that one again, not the wrapper. */
const wrappedFetches = new WeakMap<Fetch, Fetch>();

/**
 * Points the library at <dir>/models: downloads land there (env.cacheDir),
 * and once complete they are read from there as local files
 * (env.localModelPath). `remote` allows the download. The library takes no
 * AbortSignal, so its fetches (env.fetch, wrapped) are given `signal`:
 * aborting it stops a download in progress, body and all.
 */
export function configureTransformers(
  env: Record<string, unknown>,
  models: string,
  remote: boolean,
  signal?: AbortSignal,
): void {
  if (signal) {
    const current = typeof env.fetch === "function" ? (env.fetch as Fetch) : undefined;
    const inner: Fetch = (current && wrappedFetches.get(current)) ?? current ?? fetch;
    const wrapper: Fetch = (input, init = {}) =>
      inner(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    wrappedFetches.set(wrapper, inner);
    env.fetch = wrapper;
  }
  env.cacheDir = models;
  env.useFSCache = true;
  env.useBrowserCache = false;
  env.localModelPath = models + path.sep;
  env.allowLocalModels = true;
  env.allowRemoteModels = remote;
  env.logLevel = LOG_LEVEL_ERROR;
}

/**
 * Mean of the token vectors the attention mask keeps, per text, normalised.
 * `hidden` is [texts, tokens, dim]; `mask` is [texts, tokens].
 */
export function meanPool(hidden: TensorLike, mask: TensorLike): Float32Array[] {
  const [n, tokens, dim] = hidden.dims;
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const sum = new Float32Array(dim);
    let count = 0;
    for (let t = 0; t < tokens; t++) {
      if (Number(mask.data[i * tokens + t]) === 0) continue;
      count++;
      const base = (i * tokens + t) * dim;
      for (let d = 0; d < dim; d++) sum[d] += Number(hidden.data[base + d]);
    }
    if (count > 0) for (let d = 0; d < dim; d++) sum[d] /= count;
    out.push(normalize(sum));
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class ModelEmbedder implements Embedder {
  readonly id = MODEL_ID;
  readonly revision = MODEL_REVISION;
  readonly dim = MODEL_DIM;
  readonly relevance = MODEL_RELEVANCE;
  /** Where the model's files live once downloaded. */
  readonly modelDir: string;

  private readonly models: string;
  private readonly importTransformers: (onInstall: () => void) => Promise<Transformers>;
  private readonly now: () => number;
  private current: EmbedderStatus = { state: "not_started" };
  private loading: Promise<{ tokenizer: Tokenizer; model: Model }> | undefined;
  /**
   * The library once imported: a retry after the model failed to load reuses
   * it, so a runtime folder another version's mnemos pruned meanwhile is
   * neither needed nor installed again.
   */
  private transformers: Transformers | undefined;
  private failures = 0;
  /** Model runs, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Aborted by close(): the library's fetches, so a download stops at shutdown. */
  private readonly abort = new AbortController();

  constructor(options: ModelEmbedderOptions = {}) {
    this.models = modelsDir(options.dir);
    this.modelDir = path.join(this.models, ...MODEL_ID.split("/"), MODEL_REVISION);
    const dir = options.dir;
    const install = options.installRuntime;
    this.importTransformers =
      options.importTransformers ??
      ((onInstall) => loadTransformers({ dir, install, onInstall }) as Promise<Transformers>);
    this.now = options.now ?? Date.now;
  }

  status(): EmbedderStatus {
    return { ...this.current };
  }

  /**
   * Shutdown: aborts the model's download, whose fetches would otherwise keep
   * the process alive until about 135 MB have come in for a client that is
   * gone. The load then fails, and it and every later embed() reject with
   * SHUTTING_DOWN. A runtime install is stopped by runtime.ts' stopInstalls().
   */
  close(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.current = { state: "unavailable", reason: SHUTTING_DOWN };
  }

  /** Whether every model file is already in the models folder. */
  downloaded(): boolean {
    return MODEL_FILES.every((file) => fs.existsSync(path.join(this.modelDir, file)));
  }

  /**
   * Runs the model on one text at a time, yielding to the event loop between
   * runs. The q8 model quantizes its activations dynamically, one scale per
   * tensor (DynamicQuantizeLinear), so in a batch a text's vector depends on
   * the texts beside it and their padding: scores moved by up to 0.017 with
   * the batch, against a relevance cutoff tuned at about 0.005. Alone, a text
   * gets the same vector every time. Measured on 2026-10-13 (Apple M-series,
   * under load): 2,300 titles take about 6 s against 4 s in batches of 32, and
   * page chunks are no slower, having no padding.
   */
  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const run = this.queue.then(async () => {
      const vectors: Float32Array[] = [];
      for (const [i, text] of texts.entries()) {
        if (i > 0) await yieldToEventLoop();
        const inputs = tokenizer([`${kind}: ${text}`], { padding: false, truncation: true });
        const { last_hidden_state } = await model(inputs);
        vectors.push(...meanPool(last_hidden_state, inputs.attention_mask));
      }
      return vectors;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Loads the model once; concurrent callers share the attempt. After a
   * failure, calls before retry_at reject at once and the first call after
   * it tries again, and so does a runtime npm failed to install. A library
   * once imported is kept, and a retry loads only the model with it. A library
   * that cannot be imported is never retried, nor anything after close().
   */
  private load(): Promise<{ tokenizer: Tokenizer; model: Model }> {
    if (this.abort.signal.aborted) return Promise.reject(new EmbedderUnavailableError(SHUTTING_DOWN));
    if (this.loading) return this.loading;
    const s = this.current;
    if (s.state === "unavailable" && (s.retry_at === undefined || this.now() < s.retry_at)) {
      return Promise.reject(new EmbedderUnavailableError(s.reason));
    }
    this.loading = this.attempt();
    this.loading.catch(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async attempt(): Promise<{ tokenizer: Tokenizer; model: Model }> {
    this.current = { state: "loading" };
    let transformers: Transformers;
    try {
      transformers = this.transformers ??= await this.importTransformers(() => {
        this.current = { state: "installing" };
      });
    } catch (err) {
      if (this.abort.signal.aborted) throw this.closed();
      if (err instanceof RuntimeInstallError) {
        throw this.failed(`${TRANSFORMERS} could not be installed: ${message(err)}`);
      }
      const reason = `${TRANSFORMERS} could not be loaded: ${message(err)}`;
      this.current = { state: "unavailable", reason };
      throw new EmbedderUnavailableError(reason);
    }
    if (this.abort.signal.aborted) throw this.closed();
    this.current = { state: "loading" };
    try {
      const downloaded = this.downloaded();
      configureTransformers(transformers.env, this.models, !downloaded, this.abort.signal);
      // Downloaded: the revision folder, read as a local model. Not yet: the
      // repository at the pinned revision, which the library caches there.
      const id = downloaded ? `${MODEL_ID}/${MODEL_REVISION}` : MODEL_ID;
      const options: Record<string, unknown> = { revision: downloaded ? "main" : MODEL_REVISION };
      if (!downloaded) {
        this.current = { state: "downloading" };
        options.progress_callback = this.progress();
      }
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(id, options);
      const model = await transformers.AutoModel.from_pretrained(id, { ...options, dtype: MODEL_DTYPE });
      if (this.abort.signal.aborted) {
        await model.dispose?.();
        throw this.closed();
      }
      this.current = { state: "ready" };
      this.failures = 0;
      return { tokenizer, model };
    } catch (err) {
      if (this.abort.signal.aborted) throw this.closed();
      throw this.failed(`the model could not be loaded: ${message(err)}`);
    }
  }

  /** Closed: unavailable for good; the error to throw. */
  private closed(): EmbedderUnavailableError {
    this.current = { state: "unavailable", reason: SHUTTING_DOWN };
    return new EmbedderUnavailableError(SHUTTING_DOWN);
  }

  /** Unavailable until a doubling backoff has passed; the error to throw. */
  private failed(reason: string): EmbedderUnavailableError {
    const wait = Math.min(RETRY_MIN_MS * 2 ** this.failures, RETRY_MAX_MS);
    this.failures++;
    this.current = { state: "unavailable", reason, retry_at: this.now() + wait };
    return new EmbedderUnavailableError(reason);
  }

  /** Sums the per-file byte counts the library reports; "loading" once every file is done. */
  private progress(): (event: Record<string, unknown>) => void {
    const files = new Map<string, { loaded: number; total: number; done: boolean }>();
    return (event) => {
      const file = typeof event.file === "string" ? event.file : undefined;
      if (!file) return;
      const entry = files.get(file) ?? { loaded: 0, total: 0, done: false };
      files.set(file, entry);
      if (event.status === "progress") {
        if (typeof event.loaded === "number") entry.loaded = event.loaded;
        if (typeof event.total === "number") entry.total = event.total;
      } else if (event.status === "done") {
        entry.done = true;
      }
      if (this.current.state !== "downloading" && this.current.state !== "loading") return;
      const all = [...files.values()];
      if (all.every((f) => f.done)) {
        this.current = { state: "loading" };
        return;
      }
      const loaded = all.reduce((sum, f) => sum + f.loaded, 0);
      const total = all.reduce((sum, f) => sum + f.total, 0);
      this.current = total > 0 ? { state: "downloading", loaded, total } : { state: "downloading" };
    };
  }
}

// --- the fake ----------------------------------------------------------------

export interface FakeEmbedderOptions {
  /** A file whose existence embed() waits for (MNEMOS_FAKE_EMBED_GATE): a slow embedder. */
  gate?: string;
  /** A file embed() appends each embedded text to, one JSON string a line (MNEMOS_FAKE_EMBED_LOG). */
  log?: string;
  /**
   * How long each embed() call takes (MNEMOS_FAKE_EMBED_DELAY_MS): a slow
   * embedder that, like a model's run, keeps the process alive meanwhile.
   */
  delayMs?: number;
  /** A reason to report as unavailable, and to reject embed() with (MNEMOS_FAKE_EMBED_UNAVAILABLE). */
  unavailable?: string;
}

/** The fake's scores: 0 for no shared word, about 0.3 for one shared word in a short title. */
export const FAKE_RELEVANCE: Relevance = { floor: 0.2, margin: 0, window: 1 };

/**
 * Words the fake counts as the same word, standing in for what the real model
 * relates across wordings and languages. None is in the test fixture's own
 * words except the ones they stand for.
 */
const FAKE_SYNONYMS = new Map([
  ["aquarelle", "watercolor"],
  ["poems", "ποιήματα"],
  ["poetry", "ποιήματα"],
]);

/**
 * TEST ONLY (MNEMOS_EMBEDDER=fake): no model, no network. Each word of the
 * text (lower-cased letters and digits; a synonym in FAKE_SYNONYMS as the word
 * it stands for) is hashed into one of 384 slots, and the counts are
 * normalised, so texts that share words are similar and texts that share none
 * score 0 (barring hash collisions). Deterministic, and `kind` is ignored. The
 * gate and log let tests over MCP hold embedding back and count what was
 * embedded, the delay plays a model's run, and `unavailable` plays a model
 * that could not be loaded.
 */
export class FakeEmbedder implements Embedder {
  readonly id = "mnemos-fake-embedder";
  readonly revision = "1";
  readonly dim = MODEL_DIM;
  readonly relevance = FAKE_RELEVANCE;

  constructor(private readonly options: FakeEmbedderOptions = {}) {}

  status(): EmbedderStatus {
    const { unavailable } = this.options;
    return unavailable ? { state: "unavailable", reason: unavailable } : { state: "ready" };
  }

  /** Nothing to stop: the fake downloads nothing. */
  close(): void {}

  async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
    const { gate, log, unavailable, delayMs } = this.options;
    if (unavailable) throw new EmbedderUnavailableError(unavailable);
    while (gate && !fs.existsSync(gate)) {
      await new Promise((resolve) => setTimeout(resolve, 20).unref());
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (log && texts.length > 0) fs.appendFileSync(log, texts.map((t) => JSON.stringify(t) + "\n").join(""));
    return texts.map((text) => fakeVector(text, this.dim));
  }
}

/** FNV-1a over the word's UTF-16 code units. */
function hashWord(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fakeVector(text: string, dim: number = MODEL_DIM): Float32Array {
  const vector = new Float32Array(dim);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    vector[hashWord(FAKE_SYNONYMS.get(word) ?? word) % dim] += 1;
  }
  return normalize(vector);
}

// --- choosing one ------------------------------------------------------------

/**
 * The fake when MNEMOS_EMBEDDER=fake (tests only, with MNEMOS_FAKE_EMBED_GATE,
 * MNEMOS_FAKE_EMBED_LOG, MNEMOS_FAKE_EMBED_DELAY_MS and
 * MNEMOS_FAKE_EMBED_UNAVAILABLE), else the real
 * model, not yet loaded; MNEMOS_INSTALL_RUNTIME=0 keeps it from installing
 * its runtime.
 */
export function createEmbedder(
  env: NodeJS.ProcessEnv = process.env,
  options: ModelEmbedderOptions = {},
): Embedder {
  if (env.MNEMOS_EMBEDDER === "fake") {
    return new FakeEmbedder({
      gate: env.MNEMOS_FAKE_EMBED_GATE || undefined,
      log: env.MNEMOS_FAKE_EMBED_LOG || undefined,
      unavailable: env.MNEMOS_FAKE_EMBED_UNAVAILABLE || undefined,
      delayMs: Number(env.MNEMOS_FAKE_EMBED_DELAY_MS) || undefined,
    });
  }
  return new ModelEmbedder({ dir: cacheDir(env), installRuntime: env.MNEMOS_INSTALL_RUNTIME !== "0", ...options });
}
