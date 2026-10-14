/**
 * One index per bookmarks file: the semantic index is a SQLite file per
 * Bookmarks file (index-store.ts), so each selected source gets its own
 * indexer, and its own page fetcher with that file's lease. They are made on
 * first use, at startup or when semantic_search first meets the source (a
 * profile the browser switched to), and started as the server started its one
 * pair before: titles first, then pages.
 *
 * Each indexer reads its source's bookmarks with no browser prefix on the
 * folder paths, so a file's index is the same whichever browsers are selected
 * with it.
 */

import type { Fetcher } from "./fetcher.js";
import type { Indexer } from "./indexer.js";
import type { Source } from "./sources.js";

/** The index of one bookmarks file: its title indexer and its page fetcher. */
export interface SourceIndex {
  indexer: Indexer;
  fetcher?: Fetcher;
}

export class SourceIndexes {
  private readonly made = new Map<string, SourceIndex>();
  private stopped = false;

  /** `make` builds a source's indexer and fetcher, not started. */
  constructor(private readonly make: (source: Source) => SourceIndex) {}

  /** The index of `source`'s bookmarks file, made and started on first use. */
  get(source: Source): SourceIndex {
    let index = this.made.get(source.bookmarks);
    if (!index) {
      index = this.make(source);
      this.made.set(source.bookmarks, index);
      if (!this.stopped) {
        const { indexer, fetcher } = index;
        indexer.start();
        // Pages after titles: the title pass is what makes semantic_search useful first.
        if (fetcher) void indexer.idle().then(() => fetcher.start());
      }
    }
    return index;
  }

  /** The indexes made so far. */
  all(): SourceIndex[] {
    return [...this.made.values()];
  }

  /**
   * Makes and starts the index of every source `select` gives. When it
   * throws (no default browser, a missing profile), nothing is indexed until
   * semantic_search finds a source, and the tools report the error.
   */
  start(select: () => Source[]): void {
    let sources: Source[];
    try {
      sources = select();
    } catch {
      return;
    }
    for (const source of sources) this.get(source);
  }

  /** Shutdown: aborts the fetches in flight and gives the fetcher leases up, so another mnemos can take over. */
  stop(): void {
    this.stopped = true;
    for (const { fetcher } of this.made.values()) fetcher?.stop();
  }
}
