/**
 * The local index store: one SQLite file (node:sqlite, WAL mode) per Chrome
 * Bookmarks file, in mnemos's cache directory. It holds what semantic search
 * needs and what is too slow to recompute on every start: a vector per
 * bookmark title, the fetch state of each bookmarked page, the page text cut
 * into chunks with a vector each, and a heartbeat lease so only one mnemos
 * process at a time runs the background fetcher.
 *
 * Everything in it can be rebuilt from the Bookmarks file and the web, so it
 * is treated as a cache: a file from an older schema, or one that is not a
 * readable database, is set aside and rebuilt rather than reported.
 *
 * Duplicates: Chrome lets the same URL sit in several folders. Each bookmark
 * node is its own row in `bookmarks`, keyed by its Chrome `guid` (it has its
 * own title and folder, so its own title vector), while `pages` and `chunks`
 * are keyed by URL and shared by every bookmark of that URL. A page and its
 * chunks are dropped once no bookmark has its URL any more.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Bump when the schema changes, and add a step to MIGRATIONS if the old data is worth keeping. */
export const SCHEMA_VERSION = 1;

/**
 * Steps from version n to n+1, keyed by n. A file whose version has no path
 * to SCHEMA_VERSION here (including one from a newer mnemos) is rebuilt.
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {};

export type PageStatus =
  | "pending"
  | "ok"
  | "failed"
  | "skipped"
  | "needs_login"
  | "no_content"
  | "needs_browser";

export interface BookmarkRow {
  guid: string;
  url: string;
  title: string;
  folder_path: string;
  /** Omitted (undefined) leaves a stored description as it is; null clears it. */
  description?: string | null;
  /** Hash of the text the title vector is computed from: a new hash drops the vector. */
  text_hash: string;
}

export interface StoredBookmark extends Required<BookmarkRow> {
  vector: Float32Array | null;
  updated_at: number;
}

export interface PageRow {
  url: string;
  status: PageStatus;
  final_url?: string | null;
  fetched_at?: number | null;
  fail_count?: number;
  next_attempt_at?: number | null;
  content_hash?: string | null;
  reason?: string | null;
}

export interface StoredChunk {
  url: string;
  ordinal: number;
  text: string;
  vector: Float32Array | null;
}

export interface Lease {
  holder: string;
  expires_at: number;
}

export interface OpenOptions {
  /** The Bookmarks file this index belongs to; it picks the file name. */
  bookmarksFile: string;
  /** Defaults to cacheDir(). */
  dir?: string;
  /** The running embedder; when given, open() calls useModel() with it. */
  modelId?: string;
  modelRevision?: string;
  /** Clock in ms since the epoch, for tests. */
  now?: () => number;
}

// --- location ----------------------------------------------------------------

/**
 * Where mnemos keeps its index and model cache: MNEMOS_CACHE_DIR when set,
 * else the platform's per-user cache directory. Pure: the environment,
 * platform and home directory are all injectable.
 */
export function cacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  // `||`, not `??`: an empty variable means unset, as in lib.chromeBase.
  if (env.MNEMOS_CACHE_DIR) return env.MNEMOS_CACHE_DIR;
  switch (platform) {
    case "darwin":
      return path.posix.join(home, "Library", "Caches", "mnemos");
    case "win32":
      return path.win32.join(
        env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"),
        "mnemos",
        "Cache",
      );
    default: {
      // The XDG spec says a relative XDG_CACHE_HOME is invalid and is to be ignored.
      const xdg = env.XDG_CACHE_HOME;
      const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".cache");
      return path.posix.join(base, "mnemos");
    }
  }
}

/** index-<first 16 hex of sha256(absolute bookmarks path)>.sqlite, in `dir`. */
export function indexFile(bookmarksFile: string, dir: string = cacheDir()): string {
  const hash = crypto.createHash("sha256").update(path.resolve(bookmarksFile)).digest("hex");
  return path.join(dir, `index-${hash.slice(0, 16)}.sqlite`);
}

// --- vectors -----------------------------------------------------------------

/** The vector's bytes, copied, in the platform's (little-endian) byte order. */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

/** Copies, since a BLOB's bytes need not sit at a 4-byte-aligned offset. */
export function blobToVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) throw new Error(`vector BLOB of ${blob.byteLength} bytes`);
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob);
  return new Float32Array(bytes.buffer);
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const out = new Float32Array(vector.length);
  if (sum === 0) return out;
  const scale = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] * scale;
  return out;
}

/** Cosine similarity for normalised vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`vector lengths differ: ${a.length} and ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** The `limit` best-scoring items, best first; brute force, which is fast enough at our sizes. */
function topK<T>(items: Iterable<T & { score: number }>, limit: number): (T & { score: number })[] {
  if (limit <= 0) return [];
  const best: (T & { score: number })[] = [];
  for (const item of items) {
    if (best.length === limit && item.score <= best[best.length - 1].score) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].score < item.score) i--;
    best.splice(i, 0, item);
    if (best.length > limit) best.pop();
  }
  return best;
}

// --- opening -----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE bookmarks (
  guid TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  description TEXT,
  text_hash TEXT NOT NULL,
  vector BLOB,
  updated_at INTEGER NOT NULL
);
CREATE INDEX bookmarks_url ON bookmarks(url);
CREATE TABLE pages (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'ok', 'failed', 'skipped', 'needs_login', 'no_content', 'needs_browser')),
  final_url TEXT,
  fetched_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  content_hash TEXT,
  reason TEXT
);
CREATE TABLE chunks (
  url TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector BLOB,
  PRIMARY KEY (url, ordinal)
);
CREATE TABLE lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

/**
 * SQLITE_CORRUPT and SQLITE_NOTADB; anything else (a locked file, a full disk)
 * is not ours to discard. A caller that meets one after open() can close the
 * store and open it again, which rebuilds the file.
 */
export function isCorrupt(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string };
  if (e?.errcode !== undefined) return (e.errcode & 0xff) === 11 || (e.errcode & 0xff) === 26;
  return /file is not a database|database disk image is malformed/i.test(String(e?.message));
}

/** Runs `fn` in a write transaction taken up front, so two processes opening at once take turns. */
function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Opens the file, sets it up, and brings its schema to SCHEMA_VERSION; throws if it is unreadable. */
function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // Damage past the first pages only shows when those pages are read, so
    // check them all now rather than fail on every later write. About 80 ms
    // for a 200 MB index (50k chunk vectors).
    const check = db.prepare("PRAGMA quick_check(1)").get();
    if (check?.quick_check !== "ok") {
      throw Object.assign(new Error(`index failed quick_check: ${check?.quick_check}`), { errcode: 11 });
    }
    immediate(db, () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((r) => r.name as string);
      let version = 0;
      if (tables.includes("meta")) {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        version = Number(row?.value ?? 0);
      }
      while (version !== SCHEMA_VERSION && MIGRATIONS[version] && tables.length > 0) {
        MIGRATIONS[version](db);
        version++;
      }
      if (version === SCHEMA_VERSION) {
        db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
        return;
      }
      // New file, or one we cannot migrate: start over.
      for (const name of tables) {
        if (name.startsWith("sqlite_")) continue;
        db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
      }
      db.exec(SCHEMA);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    });
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // already unusable
    }
    throw err;
  }
}

/** Renames the file and its WAL and shared-memory files to <name>.corrupt-<ms>; returns the new name. */
function moveAside(file: string, now: number): string {
  const aside = `${file}.corrupt-${now}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.renameSync(file + suffix, aside + suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return aside;
}

// --- the store ---------------------------------------------------------------

export class IndexStore {
  /** Who this store is when it holds a lease: pid plus a random id, so two stores in one process differ. */
  readonly holderId = `${process.pid}:${crypto.randomUUID()}`;

  private constructor(
    private readonly db: DatabaseSync,
    readonly file: string,
    /** Where an unreadable file found at open() was moved to. */
    readonly movedAside: string | undefined,
    private readonly now: () => number,
  ) {}

  /**
   * Opens (creating if needed) the index for `bookmarksFile`. A file that is
   * not a readable database is moved aside and a new one created; other
   * errors (an unwritable cache directory, say) are thrown.
   */
  static open(options: OpenOptions): IndexStore {
    const now = options.now ?? Date.now;
    const dir = options.dir ?? cacheDir();
    const file = indexFile(options.bookmarksFile, dir);
    fs.mkdirSync(dir, { recursive: true });
    let db: DatabaseSync;
    let movedAside: string | undefined;
    try {
      db = openDatabase(file);
    } catch (err) {
      if (!isCorrupt(err)) throw err;
      movedAside = moveAside(file, now());
      db = openDatabase(file);
    }
    const store = new IndexStore(db, file, movedAside, now);
    if (options.modelId !== undefined) store.useModel(options.modelId, options.modelRevision ?? "");
    return store;
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    return immediate(this.db, fn);
  }

  // --- meta ------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? (row.value as string) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /**
   * Records the running embedder. If the index was built with another model
   * or revision, every vector is dropped (the rows stay, to be embedded
   * again) and this returns true.
   */
  useModel(modelId: string, modelRevision: string): boolean {
    return this.transaction(() => {
      const same = this.getMeta("model_id") === modelId && this.getMeta("model_revision") === modelRevision;
      if (same) return false;
      this.db.exec("UPDATE bookmarks SET vector = NULL WHERE vector IS NOT NULL");
      this.db.exec("UPDATE chunks SET vector = NULL WHERE vector IS NOT NULL");
      this.setMeta("model_id", modelId);
      this.setMeta("model_revision", modelRevision);
      return true;
    });
  }

  // --- bookmarks -------------------------------------------------------------

  /**
   * Inserts or updates bookmarks by guid. A row whose fields are unchanged is
   * left alone; one whose text_hash changed loses its vector. Returns how
   * many rows were inserted or changed.
   */
  upsertBookmarks(rows: Iterable<BookmarkRow>): number {
    return this.transaction(() => {
      const changed = this.upsertRows(rows);
      this.pruneOrphans();
      return changed;
    });
  }

  /** Deletes bookmarks by guid, and the pages and chunks of URLs no bookmark has any more. */
  deleteBookmarks(guids: Iterable<string>): number {
    return this.transaction(() => {
      const deleted = this.deleteRows(guids);
      this.pruneOrphans();
      return deleted;
    });
  }

  /**
   * Makes the bookmarks table hold exactly `rows` (the Bookmarks file as it
   * is now): upserts them and deletes every other bookmark, in one transaction.
   */
  syncBookmarks(rows: BookmarkRow[]): { changed: number; deleted: number } {
    return this.transaction(() => {
      const keep = new Set(rows.map((r) => r.guid));
      const deleted = this.deleteRows(this.bookmarkGuids().filter((guid) => !keep.has(guid)));
      const changed = this.upsertRows(rows);
      this.pruneOrphans();
      return { changed, deleted };
    });
  }

  private upsertRows(rows: Iterable<BookmarkRow>): number {
    const statement = this.db.prepare(`
      INSERT INTO bookmarks (guid, url, title, folder_path, description, text_hash, vector, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
      ON CONFLICT(guid) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        folder_path = excluded.folder_path,
        description = CASE WHEN ?8 THEN bookmarks.description ELSE excluded.description END,
        vector = CASE WHEN bookmarks.text_hash = excluded.text_hash THEN bookmarks.vector END,
        text_hash = excluded.text_hash,
        updated_at = excluded.updated_at
      WHERE bookmarks.url IS NOT excluded.url
         OR bookmarks.title IS NOT excluded.title
         OR bookmarks.folder_path IS NOT excluded.folder_path
         OR (NOT ?8 AND bookmarks.description IS NOT excluded.description)
         OR bookmarks.text_hash IS NOT excluded.text_hash`);
    const at = this.now();
    let changed = 0;
    for (const r of rows) {
      // ?8: the row passes no description, so the stored one stays.
      const keep = r.description === undefined ? 1 : 0;
      changed += Number(
        statement.run(r.guid, r.url, r.title, r.folder_path, r.description ?? null, r.text_hash, at, keep).changes,
      );
    }
    return changed;
  }

  private deleteRows(guids: Iterable<string>): number {
    const statement = this.db.prepare("DELETE FROM bookmarks WHERE guid = ?");
    let deleted = 0;
    for (const guid of guids) deleted += Number(statement.run(guid).changes);
    return deleted;
  }

  private pruneOrphans(): void {
    this.db.exec("DELETE FROM pages WHERE url NOT IN (SELECT url FROM bookmarks)");
    this.db.exec("DELETE FROM chunks WHERE url NOT IN (SELECT url FROM bookmarks)");
  }

  bookmarkGuids(): string[] {
    return this.db
      .prepare("SELECT guid FROM bookmarks ORDER BY guid")
      .all()
      .map((r) => r.guid as string);
  }

  getBookmark(guid: string): StoredBookmark | undefined {
    const row = this.db.prepare("SELECT * FROM bookmarks WHERE guid = ?").get(guid);
    return row ? toBookmark(row) : undefined;
  }

  /** Bookmarks with no vector yet: new, retitled, or dropped by a model change. */
  bookmarksWithoutVector(limit = -1): StoredBookmark[] {
    return this.db
      .prepare("SELECT * FROM bookmarks WHERE vector IS NULL ORDER BY guid LIMIT ?")
      .all(limit)
      .map(toBookmark);
  }

  /** Stores the title vector, if the bookmark still has the text_hash it was computed from. */
  setBookmarkVector(guid: string, textHash: string, vector: Float32Array): boolean {
    const result = this.db
      .prepare("UPDATE bookmarks SET vector = ? WHERE guid = ? AND text_hash = ?")
      .run(vectorToBlob(vector), guid, textHash);
    return result.changes === 1;
  }

  /** The bookmarks whose title vectors are closest to `query` (normalised), best first. */
  nearestBookmarks(query: Float32Array, limit: number): (StoredBookmark & { score: number })[] {
    const rows = this.db.prepare("SELECT * FROM bookmarks WHERE vector IS NOT NULL").iterate();
    function* scored() {
      for (const row of rows) {
        const b = toBookmark(row);
        yield { ...b, score: dot(query, b.vector!) };
      }
    }
    return topK(scored(), limit);
  }

  /** Every embedded bookmark's similarity to `query` (normalised), by guid. */
  bookmarkScores(query: Float32Array): Map<string, number> {
    const scores = new Map<string, number>();
    for (const row of this.db.prepare("SELECT guid, vector FROM bookmarks WHERE vector IS NOT NULL").iterate()) {
      scores.set(row.guid as string, dot(query, blobToVector(row.vector as Uint8Array)));
    }
    return scores;
  }

  // --- pages and chunks ------------------------------------------------------

  upsertPage(page: PageRow): void {
    this.db
      .prepare(
        `INSERT INTO pages (url, status, final_url, fetched_at, fail_count, next_attempt_at, content_hash, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           status = excluded.status, final_url = excluded.final_url, fetched_at = excluded.fetched_at,
           fail_count = excluded.fail_count, next_attempt_at = excluded.next_attempt_at,
           content_hash = excluded.content_hash, reason = excluded.reason`,
      )
      .run(
        page.url,
        page.status,
        page.final_url ?? null,
        page.fetched_at ?? null,
        page.fail_count ?? 0,
        page.next_attempt_at ?? null,
        page.content_hash ?? null,
        page.reason ?? null,
      );
  }

  getPage(url: string): Required<PageRow> | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE url = ?").get(url);
    return row ? toPage(row) : undefined;
  }

  /** Replaces the page's chunks; the new ones have no vectors yet. */
  replaceChunks(url: string, texts: string[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM chunks WHERE url = ?").run(url);
      const insert = this.db.prepare("INSERT INTO chunks (url, ordinal, text, vector) VALUES (?, ?, ?, NULL)");
      texts.forEach((text, ordinal) => insert.run(url, ordinal, text));
    });
  }

  getChunks(url: string): StoredChunk[] {
    return this.db.prepare("SELECT * FROM chunks WHERE url = ? ORDER BY ordinal").all(url).map(toChunk);
  }

  chunksWithoutVector(limit = -1): StoredChunk[] {
    return this.db
      .prepare("SELECT * FROM chunks WHERE vector IS NULL ORDER BY url, ordinal LIMIT ?")
      .all(limit)
      .map(toChunk);
  }

  /** Stores a chunk's vector, if the chunk still has the text it was computed from. */
  setChunkVector(url: string, ordinal: number, text: string, vector: Float32Array): boolean {
    const result = this.db
      .prepare("UPDATE chunks SET vector = ? WHERE url = ? AND ordinal = ? AND text = ?")
      .run(vectorToBlob(vector), url, ordinal, text);
    return result.changes === 1;
  }

  /** The chunks closest to `query` (normalised), best first. */
  nearestChunks(query: Float32Array, limit: number): (StoredChunk & { score: number })[] {
    const rows = this.db.prepare("SELECT * FROM chunks WHERE vector IS NOT NULL").iterate();
    function* scored() {
      for (const row of rows) {
        const c = toChunk(row);
        yield { ...c, score: dot(query, c.vector!) };
      }
    }
    return topK(scored(), limit);
  }

  /** Each page's chunk closest to `query` (normalised), by URL. */
  bestChunks(query: Float32Array): Map<string, { score: number; text: string }> {
    const best = new Map<string, { score: number; text: string }>();
    for (const row of this.db.prepare("SELECT url, text, vector FROM chunks WHERE vector IS NOT NULL").iterate()) {
      const url = row.url as string;
      const score = dot(query, blobToVector(row.vector as Uint8Array));
      if (score > (best.get(url)?.score ?? -Infinity)) best.set(url, { score, text: row.text as string });
    }
    return best;
  }

  /** How many pages have at least one embedded chunk. */
  embeddedPageCount(): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT url) AS n FROM chunks WHERE vector IS NOT NULL").get();
    return Number(row?.n ?? 0);
  }

  // --- lease -----------------------------------------------------------------

  /**
   * Takes the named lease for `ttlMs` if it is free, expired, or already
   * ours (which renews it). Returns whether this store now holds it.
   */
  acquireLease(name: string, ttlMs: number): boolean {
    return this.transaction(() => {
      const now = this.now();
      const current = this.getLease(name);
      if (current && current.holder !== this.holderId && current.expires_at > now) return false;
      this.db
        .prepare(
          `INSERT INTO lease (name, holder, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
        )
        .run(name, this.holderId, now + ttlMs);
      return true;
    });
  }

  /**
   * The heartbeat: extends a lease this store holds and has not let expire.
   * Returns false if the lease expired or another store took it over, and
   * the caller is to stop the work the lease guards.
   */
  renewLease(name: string, ttlMs: number): boolean {
    const now = this.now();
    const result = this.db
      .prepare("UPDATE lease SET expires_at = ? WHERE name = ? AND holder = ? AND expires_at > ?")
      .run(now + ttlMs, name, this.holderId, now);
    return result.changes === 1;
  }

  /** Gives the lease up, if this store holds it. */
  releaseLease(name: string): void {
    this.db.prepare("DELETE FROM lease WHERE name = ? AND holder = ?").run(name, this.holderId);
  }

  getLease(name: string): Lease | undefined {
    const row = this.db.prepare("SELECT holder, expires_at FROM lease WHERE name = ?").get(name);
    return row ? { holder: row.holder as string, expires_at: Number(row.expires_at) } : undefined;
  }
}

function toBookmark(row: Record<string, unknown>): StoredBookmark {
  return {
    guid: row.guid as string,
    url: row.url as string,
    title: row.title as string,
    folder_path: row.folder_path as string,
    description: (row.description as string | null) ?? null,
    text_hash: row.text_hash as string,
    vector: row.vector ? blobToVector(row.vector as Uint8Array) : null,
    updated_at: Number(row.updated_at),
  };
}

function toPage(row: Record<string, unknown>): Required<PageRow> {
  const num = (v: unknown) => (v === null ? null : Number(v));
  return {
    url: row.url as string,
    status: row.status as PageStatus,
    final_url: row.final_url as string | null,
    fetched_at: num(row.fetched_at),
    fail_count: Number(row.fail_count),
    next_attempt_at: num(row.next_attempt_at),
    content_hash: row.content_hash as string | null,
    reason: row.reason as string | null,
  };
}

function toChunk(row: Record<string, unknown>): StoredChunk {
  return {
    url: row.url as string,
    ordinal: Number(row.ordinal),
    text: row.text as string,
    vector: row.vector ? blobToVector(row.vector as Uint8Array) : null,
  };
}

