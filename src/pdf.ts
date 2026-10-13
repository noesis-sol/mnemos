/**
 * Text extraction for bookmarked PDFs. safeFetch hands back a PDF's bytes
 * (application/pdf, up to the same size cap as pages); this turns them into
 * plain text for the index, which chunks and embeds it as it does page text.
 *
 * The parser is pdf.js, through unpdf: unpdf bundles a serverless build of
 * pdf.js with its worker inlined and no eval, in one 2.5 MB package with no
 * dependencies (pdfjs-dist itself is 35 MB, plus 28 MB of native canvas
 * binaries it pulls in for rendering, which text extraction never needs).
 * unpdf is an optionalDependency loaded with import() on first use: when it
 * is missing or fails to load, extraction reports "unavailable" and mnemos
 * keeps going without PDFs.
 *
 * Without pdfjs-dist installed, pdf.js has no CMap files, so text drawn in
 * the predefined CJK CMaps of older PDFs is not recovered; Unicode-mapped
 * fonts (most PDFs made this century) are.
 */

/** The part of unpdf this module uses: the pdf.js build it bundles. */
export interface PdfModule {
  getResolvedPDFJS(): Promise<{ getDocument(params: Record<string, unknown>): PdfLoadingTask }>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfPage {
  getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
  cleanup(): unknown;
}

export type PdfTextResult =
  | {
      status: "ok";
      /** Each page's lines joined by spaces, whitespace collapsed; pages separated by a blank line. */
      text: string;
      /** Pages in the document. */
      pages: number;
      /** Pages read: fewer than `pages` when maxPages or maxChars stopped early. */
      pagesRead: number;
      truncated: boolean;
    }
  /** The PDF parser is not installed or did not load. */
  | { status: "unavailable"; reason: string }
  /** encrypted: needs a password to open. invalid: not a readable PDF. */
  | { status: "failed"; reason: "encrypted" | "invalid" | "aborted" | "error"; detail?: string };

export const MAX_PDF_PAGES = 200;
/** Enough for the index's per-page chunk cap several times over. */
export const MAX_PDF_CHARS = 200_000;

export interface PdfTextOptions {
  /** Defaults to MAX_PDF_PAGES. */
  maxPages?: number;
  /** Stops reading pages once this much text is in; the text is cut to it. Defaults to MAX_PDF_CHARS. */
  maxChars?: number;
  /** Checked between pages; an abort ends extraction with reason "aborted". */
  signal?: AbortSignal;
  /** Loads the parser; defaults to import("unpdf"), once per process. For tests. */
  load?: () => Promise<PdfModule>;
}

const UNPDF = "unpdf"; // a variable, so tsc does not need the optional package to build

let loaded: Promise<PdfModule> | undefined;

/** import("unpdf"), once: a parser that failed to load is not retried in this process. */
function loadUnpdf(): Promise<PdfModule> {
  loaded ??= import(UNPDF) as Promise<PdfModule>;
  return loaded;
}

/** Whether PDFs can be read here; callers that cannot read them need not fetch them. */
export async function pdfSupport(
  load: () => Promise<PdfModule> = loadUnpdf,
): Promise<{ available: true } | { available: false; reason: string }> {
  try {
    const pdfjs = await (await load()).getResolvedPDFJS();
    if (typeof pdfjs?.getDocument !== "function") return { available: false, reason: "unpdf's pdf.js has no getDocument" };
    return { available: true };
  } catch (err) {
    return { available: false, reason: `unpdf did not load: ${String(err)}` };
  }
}

/** True when `bytes` carries the %PDF- header, which may sit anywhere in the first 1024 bytes. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  return head.includes("%PDF-", 0, "latin1");
}

/** One page's text: lines joined by single spaces, runs of whitespace collapsed. */
function pageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  return items
    .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Extracts the text of a PDF, page by page, yielding to the event loop
 * between pages so tool calls are answered while a long document is read.
 * Never throws: a missing parser, an encrypted or broken file, or an abort
 * come back as data. pdf.js's warnings are silenced, since mnemos's stdout is
 * the MCP channel and its stderr ends up in the client's log.
 */
export async function extractPdfText(bytes: Uint8Array, options: PdfTextOptions = {}): Promise<PdfTextResult> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const maxChars = options.maxChars ?? MAX_PDF_CHARS;
  const { signal } = options;
  let getDocument: (params: Record<string, unknown>) => PdfLoadingTask;
  try {
    const pdfjs = await (await (options.load ?? loadUnpdf)()).getResolvedPDFJS();
    getDocument = pdfjs.getDocument.bind(pdfjs);
  } catch (err) {
    return { status: "unavailable", reason: `unpdf did not load: ${String(err)}` };
  }
  if (signal?.aborted) return { status: "failed", reason: "aborted" };
  let task: PdfLoadingTask | undefined;
  const abort = () => void task?.destroy().catch(() => {});
  signal?.addEventListener("abort", abort);
  try {
    task = getDocument({
      // pdf.js refuses a Buffer, and may take ownership of the bytes: give it its own plain copy.
      data: new Uint8Array(bytes),
      verbosity: 0, // errors only, and those are thrown to us
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    });
    const doc = await task.promise;
    const pages: string[] = [];
    let chars = 0;
    let pagesRead = 0;
    for (let n = 1; n <= doc.numPages && pagesRead < maxPages && chars < maxChars; n++) {
      if (signal?.aborted) return { status: "failed", reason: "aborted" };
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      page.cleanup();
      pagesRead++;
      if (text) {
        pages.push(text);
        chars += text.length + 2;
      }
      await yieldToEventLoop();
    }
    if (signal?.aborted) return { status: "failed", reason: "aborted" };
    let text = pages.join("\n\n");
    const cut = text.length > maxChars;
    if (cut) text = text.slice(0, /[\uD800-\uDBFF]/.test(text[maxChars - 1]) ? maxChars - 1 : maxChars);
    return { status: "ok", text, pages: doc.numPages, pagesRead, truncated: cut || pagesRead < doc.numPages };
  } catch (err) {
    if (signal?.aborted) return { status: "failed", reason: "aborted" };
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") return { status: "failed", reason: "encrypted" };
    if (name === "InvalidPDFException") return { status: "failed", reason: "invalid", detail: String(err) };
    return { status: "failed", reason: "error", detail: String(err) };
  } finally {
    signal?.removeEventListener("abort", abort);
    await task?.destroy().catch(() => {});
  }
}
