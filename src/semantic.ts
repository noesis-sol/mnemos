/**
 * semantic_search: the user's bookmarks ranked by meaning rather than by
 * exact words, from the vectors the background indexer stores.
 *
 * A bookmark scores the higher of its title vector's similarity to the query
 * and its best page chunk's (page chunks come from the page fetcher; with none
 * the title decides). Bookmarks matching every query word as search_bookmarks
 * does are keyword hits: they are always returned and rank above every other
 * hit, so an exact match never sinks below a loosely related one. Other
 * bookmarks are returned only if they clear the embedder's relevance cutoff.
 *
 * Until the embedder is ready, or while the index cannot be read, the answer
 * is the keyword hits alone, and the status says why. Every answer carries
 * the status: indexing progress, the embedder's state and whether page
 * fetching is disabled.
 */

import type { EmbedderStatus, Embedder, Relevance } from "./embedder.js";
import { bookmarkRows, type Indexer, type IndexScores } from "./indexer.js";
import * as lib from "./lib.js";

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
  indexer: Indexer;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

type MatchedOn = "title" | "page" | "keyword";

/** Page fetching is on unless MNEMOS_FETCH_PAGES=0. */
export function fetchingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MNEMOS_FETCH_PAGES?.trim() === "0";
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

/** Whitespace collapsed, and cut at a word boundary near SNIPPET_CHARS. */
export function snippet(text: string, max: number = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
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

export async function semanticSearch(
  ctx: SemanticContext,
  query: string,
  folder?: string,
  limit?: number,
): Promise<unknown> {
  const words = lib.queryWords(query);
  if (words.length === 0) {
    return {
      error:
        "Empty query. Describe what you are looking for, or use " +
        "list_folders / recent_bookmarks to browse instead.",
    };
  }
  const filter = folder?.trim() ? folder : undefined;
  const { embedder, indexer } = ctx;
  indexer.checkForChanges();

  const entries = [...lib.allBookmarks()];
  const guids = bookmarkRows(entries).map((row) => row.guid);
  const keywordHit = lib.keywordMatcher(words);

  // Semantic scores, or the reason there are none. A model not started yet
  // (after a restart there are no titles to embed, so nothing else loads it)
  // is started by this query, which is answered semantically if it loads in time.
  const embedderStatus = embedder.status();
  let scores: IndexScores | undefined;
  let fallback: string | undefined;
  if (embedderStatus.state !== "ready" && embedderStatus.state !== "not_started") {
    fallback = notReadyReason(embedderStatus);
  } else {
    try {
      scores = indexer.scores(await embedQuery(embedder, query, QUERY_EMBED_TIMEOUT_MS));
      if (!scores) {
        const { state, error } = indexer.status();
        fallback = state === "failed" ? `the index could not be built: ${error}` : "the index is not open yet";
      }
    } catch (err) {
      const now = embedder.status();
      fallback = now.state === "ready" ? message(err) : notReadyReason(now);
    }
  }

  const candidates: { entry: lib.Entry; keyword: boolean; score: number | null; page?: string }[] = [];
  entries.forEach((entry, i) => {
    if (filter && !lib.folderMatches(entry.folder, filter)) return;
    const keyword = keywordHit(entry);
    const title = scores?.titles.get(guids[i]);
    const page = scores?.pages.get(entry.node.url ?? "");
    if (page !== undefined && (title === undefined || page.score > title)) {
      candidates.push({ entry, keyword, score: page.score, page: page.text });
    } else {
      candidates.push({ entry, keyword, score: title ?? null });
    }
  });

  let hits: typeof candidates;
  if (!scores) {
    hits = candidates.filter((c) => c.keyword);
  } else {
    const { floor, window } = embedder.relevance;
    const margin = relevanceMargin(embedder.relevance, scores.titles.size);
    const best = candidates.reduce((max, c) => Math.max(max, c.score ?? -Infinity), -Infinity);
    const cutoff = Math.max(floor, median(scores.titles.values()) + margin, best - window);
    hits = candidates.filter((c) => c.keyword || (c.score !== null && c.score >= cutoff));
    // Keyword hits first; each group by score, unscored last. sort() is stable.
    hits.sort((a, b) => Number(b.keyword) - Number(a.keyword) || (b.score ?? -Infinity) - (a.score ?? -Infinity));
  }

  const results = hits.slice(0, lib.cap(limit, DEFAULT_LIMIT, MAX_LIMIT)).map((hit) => {
    let matched_on: MatchedOn = hit.page !== undefined ? "page" : "title";
    if (hit.keyword || hit.score === null) matched_on = "keyword";
    return {
      ...lib.fmt(hit.entry),
      score: hit.score === null ? null : round(hit.score),
      matched_on,
      ...(hit.page !== undefined ? { snippet: snippet(hit.page) } : {}),
    };
  });

  const { state: titlesState, titles_done, titles_total } = indexer.status();
  const pagesTotal = new Set(entries.map((e) => e.node.url ?? "").filter((url) => /^https?:/i.test(url))).size;
  let note: string | undefined;
  if (fallback) {
    note = `Keyword matches only (as search_bookmarks): ${fallback}. Retry later for semantic results.`;
  } else if (titlesState !== "ready") {
    note =
      `Bookmark titles are still being embedded (${titles_done} of ${titles_total || entries.length}); ` +
      "the rest are found only by exact words for now.";
  }
  const status = {
    progress: `titles ${titles_done}/${titles_total || entries.length} · pages ${indexer.embeddedPages()}/${pagesTotal}`,
    search: scores ? "semantic" : "keyword",
    indexing: titlesState.replace("_", " "),
    embedder: embedderState(embedder.status()),
    fetching_disabled: fetchingDisabled(ctx.env),
    ...(note ? { note } : {}),
  };

  if (hits.length === 0) {
    return {
      count_above_threshold: 0,
      results: [],
      status,
      note:
        (scores ? `Nothing relates closely to "${query}"` : `No bookmarks match "${query}"`) +
        (filter
          ? ` in folders matching "${filter}". The folder name may be wrong — call list_folders ` +
            "to check, or retry without `folder`."
          : "."),
    };
  }
  return { count_above_threshold: hits.length, results, status };
}
