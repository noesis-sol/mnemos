/**
 * The readable text of a fetched page: Readability (Mozilla's reader view) on
 * a linkedom document, whitespace collapsed, or why there is none (a login
 * wall, or too little text, as a JS-only shell has).
 *
 * Parsing a large page takes CPU time in the hundreds of milliseconds per
 * megabyte, so the fetcher runs extractPage in a worker thread (Extractor and
 * extract-worker.ts): the server's event loop, and with it every tool call,
 * never waits for it.
 */

import { Worker } from "node:worker_threads";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** Readable text shorter than this is no page content (a JS shell, an error page). */
export const MIN_TEXT_CHARS = 200;
/** A page with a password field or on a login path is a login wall if its text is shorter than this. */
export const LOGIN_TEXT_CHARS = 1_000;
/** Text kept per page: enough for the chunker's per-page cap several times over. */
export const MAX_TEXT_CHARS = 200_000;

/**
 * Block-level tags: a space goes before each, so text in adjacent blocks
 * ("<p>one</p><p>two</p>") stays two words once whitespace is collapsed.
 */
const BLOCK_TAG =
  /<(\/?)(address|article|aside|blockquote|br|caption|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\b/gi;

/** Last path segments of sign-in pages. */
const LOGIN_SEGMENTS = new Set([
  "login",
  "log-in",
  "logon",
  "signin",
  "sign-in",
  "sign_in",
  "sso",
  "auth",
  "authenticate",
  "authorize",
  "oauth",
  "session",
  "sessions",
]);

// --- extraction --------------------------------------------------------------

export type Extraction =
  | { status: "ok"; text: string }
  | { status: "needs_login" | "no_content"; reason: string }
  /** The extractor threw: the page is retried with backoff, like a failed fetch. */
  | { status: "failed"; reason: string };

/** Whitespace collapsed to single spaces. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True for a URL whose path is a sign-in page: /login, /accounts/sign-in, /oauth/authorize… */
export function isLoginUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.pathname
    .toLowerCase()
    .split("/")
    .some((segment) => LOGIN_SEGMENTS.has(segment.replace(/\.(?:html?|php|aspx?|jsp)$/, "")));
}

/**
 * A linkedom document with an <html> and a <body>. HTML lets a page leave
 * both tags out, and linkedom, unlike a browser, does not add them; without
 * them it has no body and Readability refuses the document.
 */
function asDocument(html: string) {
  let source = html.replace(/^\s*<!doctype[^>]*>/i, "");
  if (!/<html[\s>]/i.test(source)) source = `<html>${source}</html>`;
  if (!/<body[\s>]/i.test(source)) {
    const head = source.match(/^([\s\S]*?<\/head\s*>)([\s\S]*)$/i);
    source = head
      ? `${head[1]}<body>${head[2]}</body>`
      : source.replace(/<html([^>]*)>/i, "<html$1><body>").replace(/<\/html\s*>/i, "</body></html>");
  }
  return parseHTML(source).document;
}

/**
 * The readable text of an HTML page, or why it has none: a login wall (a
 * password field, or a final URL on a login path, with little text) is
 * needs_login, and a page with under MIN_TEXT_CHARS of readable text
 * (a JS-only shell) is no_content.
 */
export function extractPage(html: string, url: string): Extraction {
  // Scripts and styles are never text; dropping them first makes the parse cheaper.
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(BLOCK_TAG, " <$1$2");
  const document = asDocument(stripped);
  const password = [...document.querySelectorAll("input")].some(
    (input) => (input.getAttribute("type") ?? "").trim().toLowerCase() === "password",
  );
  // Readability changes the document, so the password field is looked for first.
  const article = new Readability(document as unknown as Document).parse();
  const text = normalizeText(article?.textContent ?? "");
  if (text.length < LOGIN_TEXT_CHARS) {
    if (password) return { status: "needs_login", reason: "password field" };
    if (isLoginUrl(url)) return { status: "needs_login", reason: "login URL" };
  }
  if (text.length < MIN_TEXT_CHARS) {
    return { status: "no_content", reason: `${text.length} characters of readable text` };
  }
  return { status: "ok", text: Array.from(text).slice(0, MAX_TEXT_CHARS).join("") };
}


// --- the worker --------------------------------------------------------------

/** An extraction taking longer than this is given up, and the worker restarted. */
export const EXTRACT_TIMEOUT_MS = 30_000;

/** What extract-worker.ts receives and answers. */
export interface ExtractRequest {
  id: number;
  html: string;
  url: string;
}
export type ExtractResponse = { id: number; result: Extraction } | { id: number; error: string };

interface Waiting {
  resolve: (result: Extraction) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * extractPage in a worker thread, started on first use. The worker does one
 * page at a time; a page that takes over `timeoutMs` (counted from the call),
 * or a worker that dies, fails the pages waiting on it, and the next call
 * starts a new worker. Neither the worker nor its timers keep the process
 * alive.
 */
export class Extractor {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly waiting = new Map<number, Waiting>();

  constructor(private readonly timeoutMs: number = EXTRACT_TIMEOUT_MS) {}

  extract(html: string, url: string): Promise<Extraction> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise<Extraction>((resolve, reject) => {
      const timer = setTimeout(
        () => this.reset(new Error(`extraction took longer than ${this.timeoutMs / 1000} s`)),
        this.timeoutMs,
      );
      timer.unref();
      this.waiting.set(id, { resolve, reject, timer });
      worker.postMessage({ id, html, url } satisfies ExtractRequest);
    });
  }

  /** Stops the worker; extractions waiting on it fail. */
  close(): void {
    this.reset(new Error("extraction stopped"));
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./extract-worker.js", import.meta.url));
    worker.unref();
    worker.on("message", (response: ExtractResponse) => {
      const waiting = this.waiting.get(response.id);
      if (!waiting) return;
      this.waiting.delete(response.id);
      clearTimeout(waiting.timer);
      if ("error" in response) waiting.reject(new Error(response.error));
      else waiting.resolve(response.result);
    });
    worker.on("error", (err) => {
      if (this.worker === worker) this.reset(err);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.reset(new Error(`the extraction worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  /** Terminates the worker and fails everything waiting on it. */
  private reset(err: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate().catch(() => undefined);
    for (const waiting of this.waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(err);
    }
    this.waiting.clear();
  }
}
