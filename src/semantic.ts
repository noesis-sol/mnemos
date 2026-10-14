/**
 * semantic_search: the user's bookmarks ranked by meaning rather than by
 * exact words, from the vectors the background indexer stores.
 *
 * A bookmark scores the higher of its title vector's similarity to the query
 * and its best page chunk's (the indexer cuts fetched pages into chunks; with none
 * the title decides). Bookmarks matching every query word as search_bookmarks
 * does are keyword hits: they are always returned and rank above every other
 * hit, so an exact match never sinks below a loosely related one. Other
 * bookmarks are returned only if they clear the embedder's relevance cutoff.
 *
 * Until the embedder is ready, or while the index cannot be read, the answer
 * is the keyword hits alone, and the status says why. Every answer carries
 * the status: indexing progress, the embedder's state, whether page
 * fetching is disabled, how many pages are in each fetch state, and how many
 * pages wait for a browser there is none of.
 *
 * Several sources (--browser with a list, or all): each bookmarks file has
 * its own index (source-indexes.ts). The query is embedded once and scored
 * against every index; the candidates of all sources are then ranked as one
 * library: one cutoff, from the median of all their titles' scores, and
 * keyword hits first. A source whose index is not open yet contributes its
 * keyword hits only. A URL saved in several sources is one result, the
 * best-ranked of its bookmarks. The status adds the sources' progress and page
 * counts up.
 */

import type { EmbedderStatus, Embedder, Relevance } from "./embedder.js";
import { fetchingDisabled, type Fetcher } from "./fetcher.js";
import { bookmarkRows, type Indexer, type IndexerStatus, type IndexScores } from "./indexer.js";
import * as lib from "./lib.js";
import type { SourceIndex } from "./source-indexes.js";
import type { Source } from "./sources.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** A page match's snippet is its best chunk, cut to about this many characters. */
export const SNIPPET_CHARS = 300;
/**
 * How long a query waits for its vector before the answer falls back to
 * keyword hits: the model may be busy with a batch of titles, or stuck.
 */
export const QUERY_EMBED_TIMEOUT_MS = 3_000;

export interface SemanticContext {
  embedder: Embedder;
  /** The index of each source's bookmarks file (SourceIndexes.get); without it, `indexer` serves every source. */
  indexes?: (source: Source) => SourceIndex;
  indexer?: Indexer;
  /** The page fetcher of `indexer`, whose state the status reports; absent, it is not reported. */
  fetcher?: Fetcher;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

type MatchedOn = "title" | "page" | "keyword";

export { fetchingDisabled };

/** The fetcher's state in a few words: "fetching", "another mnemos process is fetching"… */
function fetcherState(fetcher: Fetcher): string {
  const { state, error } = fetcher.status();
  switch (state) {
    case "standby":
      return "another mnemos process is fetching";
    case "failed":
      return `failed: ${error}`;
    default:
      return state.replace("_", " ");
  }
}

/** The embedder's state in a few words: "ready", "downloading 42%", "unavailable". */
function embedderState(status: EmbedderStatus): string {
  if (status.state === "downloading" && status.total) {
    return `downloading ${Math.floor((100 * (status.loaded ?? 0)) / status.total)}%`;
  }
  return status.state.replace("_", " ");
}

/** Why there are no semantic results while the embedder is not ready. */
function notReadyReason(status: EmbedderStatus): string {
  switch (status.state) {
    case "unavailable":
      return `the embedding model is unavailable: ${status.reason}`;
    case "installing":
      return "the embedding runtime is still installing (first start only)";
    case "downloading":
      return "the embedding model is still downloading (first start only)";
    case "loading":
      return "the embedding model is still loading";
    default:
      return "the embedding model has not started loading yet";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The vector, or rejects once `ms` have passed. */
async function embedQuery(embedder: Embedder, query: string, ms: number): Promise<Float32Array> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the embedding model did not answer within ${ms / 1000} s`)), ms);
  });
  try {
    const [vector] = await Promise.race([embedder.embed([query], "query"), timeout]);
    return vector;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whitespace collapsed, and cut at a word boundary near `max` characters. If
 * none of the query's `words` is in the first part of the text, it starts a
 * little before the first one there is, from a word start, with "…" before.
 */
export function snippet(text: string, max: number = SNIPPET_CHARS, words: string[] = []): string {
  let flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let lead = "";
  const lower = flat.toLowerCase();
  const found = words
    .map((word) => lower.indexOf(word.toLowerCase()))
    .filter((at) => at >= 0)
    .reduce((min, at) => Math.min(min, at), Infinity);
  if (found !== Infinity && found > max * 0.6) {
    let start = Math.max(0, found - Math.floor(max / 4));
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < found) start = space + 1;
    flat = flat.slice(start);
    lead = "…";
    max -= 1;
    if (flat.length <= max) return lead + flat;
  }
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${lead}${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The margin over the median title for a library of `titles` embedded
 * titles: the relevance's margin, scaled by √(ln titles / ln marginTitles)
 * when it says what size it was calibrated on. A small library's best
 * unrelated title stands less far above its median, and so do its related
 * ones; an unscaled margin cut those.
 */
export function relevanceMargin(relevance: Relevance, titles: number): number {
  const { margin, marginTitles } = relevance;
  if (!marginTitles || marginTitles < 2) return margin;
  return margin * Math.sqrt(Math.log(Math.max(titles, 1)) / Math.log(marginTitles));
}

/** -Infinity for no values. */
function median(values: Iterable<number>): number {
  const sorted = Float64Array.from(values).sort();
  return sorted.length === 0 ? -Infinity : sorted[Math.floor(sorted.length / 2)];
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
}

/** The worst of the indexes' states: failed, then indexing, not started, ready. */
function combinedState(statuses: IndexerStatus[]): IndexerStatus["state"] {
  const order: IndexerStatus["state"][] = ["failed", "indexing", "not_started", "ready"];
  return order.find((state) => statuses.some((s) => s.state === state)) ?? "ready";
}

function sum(values: number[]): number {
  return values.reduce((total, n) => total + n, 0);
}

export async function semanticSearch(
  ctx: SemanticContext,
  query: string,
  folder?: string,
  limit?: number,
): Promise<unknown> {
  const words = lib.queryWords(query);
  if (words.length === 0) {
    throw new Error(
      "Empty query. Describe what you are looking for, or use " +
        "list_folders / recent_bookmarks to browse instead.",
    );
  }
  const filter = folder?.trim() ? folder : undefined;
  const { embedder } = ctx;
  const bookmarks = lib.readBookmarks();
  let single: SourceIndex | undefined;
  const indexOf = (source: Source): SourceIndex => {
    if (ctx.indexes) return ctx.indexes(source);
    if (!ctx.indexer) throw new Error("semantic search has no index");
    return (single ??= { indexer: ctx.indexer, fetcher: ctx.fetcher });
  };
  // Each source read: its bookmarks as its index keys them (folder paths with
  // no browser prefix), the prefix results show, and its index.
  const parts = bookmarks.read.map(({ source, roots, prefix }) => {
    const entries = [...lib.rootBookmarks(roots)];
    return {
      source,
      entries,
      guids: bookmarkRows(entries).map((row) => row.guid),
      prefix,
      index: indexOf(source),
    };
  });
  const indexes = [...new Set(parts.map((part) => part.index))];
  for (const { indexer } of indexes) indexer.checkForChanges();
  const keywordHit = lib.keywordMatcher(words);

  // Semantic scores, or the reason there are none. A model not started yet
  // (after a restart there are no titles to embed, so nothing else loads it)
  // is started by this query, which is answered semantically if it loads in time.
  const embedderStatus = embedder.status();
  const scored = new Map<SourceIndex, IndexScores>();
  let fallback: string | undefined;
  if (embedderStatus.state !== "ready" && embedderStatus.state !== "not_started") {
    fallback = notReadyReason(embedderStatus);
  } else {
    try {
      const vector = await embedQuery(embedder, query, QUERY_EMBED_TIMEOUT_MS);
      for (const index of indexes) {
        const scores = index.indexer.scores(vector);
        if (scores) scored.set(index, scores);
      }
      if (scored.size === 0) {
        const failed = indexes.map((i) => i.indexer.status()).find((s) => s.state === "failed");
        fallback = failed ? `the index could not be built: ${failed.error}` : "the index is not open yet";
      }
    } catch (err) {
      const now = embedder.status();
      fallback = now.state === "ready" ? message(err) : notReadyReason(now);
    }
  }

  const candidates: { entry: lib.Entry; part: number; keyword: boolean; score: number | null; page?: string }[] = [];
  for (const [at, part] of parts.entries()) {
    const scores = scored.get(part.index);
    part.entries.forEach((local, i) => {
      const entry = { folder: part.prefix + local.folder, node: local.node };
      if (filter && !lib.folderMatches(entry.folder, filter)) return;
      const keyword = keywordHit(entry);
      const title = scores?.titles.get(part.guids[i]);
      const page = scores?.pages.get(entry.node.url ?? "");
      if (page !== undefined && (title === undefined || page.score > title)) {
        candidates.push({ entry, part: at, keyword, score: page.score, page: page.text });
      } else {
        candidates.push({ entry, part: at, keyword, score: title ?? null });
      }
    });
  }

  let hits: typeof candidates;
  if (scored.size === 0) {
    hits = candidates.filter((c) => c.keyword);
  } else {
    // One library: the median and the margin's scale over every source's titles.
    const titleScores = [...scored.values()].flatMap((scores) => [...scores.titles.values()]);
    const { floor, window } = embedder.relevance;
    const margin = relevanceMargin(embedder.relevance, titleScores.length);
    const best = candidates.reduce((max, c) => Math.max(max, c.score ?? -Infinity), -Infinity);
    const cutoff = Math.max(floor, median(titleScores) + margin, best - window);
    hits = candidates.filter((c) => c.keyword || (c.score !== null && c.score >= cutoff));
    // Keyword hits first; each group by score, unscored last. sort() is stable.
    hits.sort((a, b) => Number(b.keyword) - Number(a.keyword) || (b.score ?? -Infinity) - (a.score ?? -Infinity));
  }
  // A URL in several sources is returned once, from the source of its
  // best-ranked bookmark; one source's own repeats of it stay, as with one source.
  const taken = new Map<string, number>();
  hits = hits.filter((hit) => {
    const url = hit.entry.node.url ?? "";
    if (!taken.has(url)) taken.set(url, hit.part);
    return taken.get(url) === hit.part;
  });

  const results = hits.slice(0, lib.cap(limit, DEFAULT_LIMIT, MAX_LIMIT)).map((hit) => {
    let matched_on: MatchedOn = hit.page !== undefined ? "page" : "title";
    if (hit.keyword || hit.score === null) matched_on = "keyword";
    return {
      ...lib.fmt(hit.entry),
      score: hit.score === null ? null : round(hit.score),
      matched_on,
      ...(hit.page !== undefined ? { snippet: snippet(hit.page, SNIPPET_CHARS, words) } : {}),
    };
  });

  // Progress and counts, added up over the indexes.
  const statuses = indexes.map((index) => index.indexer.status());
  const titlesDone = sum(statuses.map((s) => s.titles_done));
  const titlesTotal = sum(
    indexes.map((index, i) => {
      const read = sum(parts.filter((part) => part.index === index).map((part) => part.entries.length));
      return statuses[i].titles_total || read;
    }),
  );
  const titlesState = combinedState(statuses);
  const pagesTotal = sum(
    parts.map(
      (part) => new Set(part.entries.map((e) => e.node.url ?? "").filter((url) => /^https?:/i.test(url))).size,
    ),
  );
  const pageStates: Record<string, number> = {};
  for (const index of indexes) {
    for (const [state, n] of Object.entries(index.indexer.pageCounts())) pageStates[state] = (pageStates[state] ?? 0) + (n ?? 0);
  }
  let note: string | undefined;
  if (fallback) {
    note = `Keyword matches only (as search_bookmarks): ${fallback}. Retry later for semantic results.`;
  } else if (titlesState === "failed") {
    const errors = statuses.filter((s) => s.state === "failed").map((s) => s.error);
    note =
      `Some sources' indexes could not be built (${errors.join("; ")}); ` +
      "their bookmarks are found only by exact words for now.";
  } else if (titlesState !== "ready") {
    note =
      `Bookmark titles are still being embedded (${titlesDone} of ${titlesTotal}); ` +
      "the rest are found only by exact words for now.";
  }
  // Each fetcher's state; prefixed with its source's browser when the sources' states differ.
  const fetchers = indexes.flatMap((index) => (index.fetcher ? [{ index, fetcher: index.fetcher }] : []));
  const fetching = fetchers.map(({ fetcher }) => fetcherState(fetcher));
  const fetchingText =
    new Set(fetching).size <= 1
      ? fetching[0]
      : fetchers
          .map(({ index }, i) => {
            const part = parts.find((p) => p.index === index)!;
            return `${lib.sourceLabel(part.source, part.prefix)}: ${fetching[i]}`;
          })
          .join("; ");
  const browser = fetchers.map(({ fetcher }) => fetcher.browserNote()).find((n) => n !== undefined);
  const status = {
    progress: `titles ${titlesDone}/${titlesTotal} · pages ${sum(indexes.map((i) => i.indexer.embeddedPages()))}/${pagesTotal}`,
    search: scored.size > 0 ? "semantic" : "keyword",
    indexing: titlesState.replace("_", " "),
    embedder: embedderState(embedder.status()),
    fetching_disabled: fetchingDisabled(ctx.env),
    // Pages per fetch state: pending, ok, needs_browser, needs_login, no_content, failed, skipped.
    page_states: pageStates,
    ...(fetchingText !== undefined ? { fetching: fetchingText } : {}),
    // "N pages need a browser; set MNEMOS_BROWSER", while there is none to render them with.
    ...(browser ? { browser } : {}),
    ...(note ? { note } : {}),
  };
  // Once per index: tell the user their pages are being fetched, and how to stop it.
  const notice = fetchers.map(({ fetcher }) => fetcher.takeNote()).find((n) => n !== undefined);

  if (hits.length === 0) {
    return {
      count_above_threshold: 0,
      results: [],
      status,
      note:
        (scored.size > 0 ? `Nothing relates closely to "${query}"` : `No bookmarks match "${query}"`) +
        (filter
          ? ` in folders matching "${filter}". The folder name may be wrong — call list_folders ` +
            "to check, or retry without `folder`."
          : "."),
      ...(notice ? { notice } : {}),
      ...bookmarks.report,
    };
  }
  return {
    count_above_threshold: hits.length,
    results,
    status,
    ...(notice ? { notice } : {}),
    ...bookmarks.report,
  };
}
