/**
 * The character encoding of a fetched HTML page, found the way a browser
 * finds it (the HTML standard's encoding sniffing, without the parts that
 * need a parser): a byte order mark, else the charset of the Content-Type
 * header, else a <meta charset> or <meta http-equiv="Content-Type"> in the
 * first 1024 bytes, else UTF-8. Many older pages declare their encoding only
 * in a <meta>; decoding them as UTF-8 indexes mojibake.
 *
 * Labels map to encodings through TextDecoder, which implements the Encoding
 * standard's label table, so "latin1" and "iso-8859-1" both come out as
 * windows-1252, as in a browser. Node 22's lacks iso-8859-16 and
 * x-user-defined, which are then unknown labels; a <meta> naming
 * x-user-defined still means windows-1252.
 */

/** How far into the body the <meta> prescan looks, as in the HTML standard. */
export const PRESCAN_BYTES = 1024;

/** The encoding a label names (its canonical name), or null when TextDecoder knows no such label. */
export function encodingForLabel(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
}

/** The encoding a byte order mark at the start of `bytes` names, or null without one. */
export function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return null;
}

const isSpace = (c: number | undefined) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isAlpha = (c: number | undefined) => c !== undefined && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a));
const lower = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);

/** True when `bytes` at `at` start with the ASCII `word`, ignoring case. */
function startsWith(bytes: Uint8Array, at: number, word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (at + i >= bytes.length || lower(bytes[at + i]) !== word.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The charset a meta content attribute names, as in `text/html; charset=Shift_JIS`
 * (the HTML standard's "extracting a character encoding from a meta element").
 */
export function charsetFromContent(content: string): string | null {
  const text = content.toLowerCase();
  let at = 0;
  for (;;) {
    const found = text.indexOf("charset", at);
    if (found < 0) return null;
    let i = found + "charset".length;
    while (isSpace(text.charCodeAt(i))) i++;
    if (text[i] !== "=") {
      at = found + "charset".length;
      continue;
    }
    i++;
    while (isSpace(text.charCodeAt(i))) i++;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, i + 1);
      return end < 0 ? null : content.slice(i + 1, end);
    }
    let end = i;
    while (end < content.length && !isSpace(content.charCodeAt(end)) && content[end] !== ";") end++;
    return end > i ? content.slice(i, end) : null;
  }
}

/** Reads markup with a cursor, for the prescan. */
class Scanner {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  get byte(): number | undefined {
    return this.bytes[this.at];
  }

  /** Moves past the next ">" (or to the end). */
  skipPastGreaterThan(): void {
    while (!this.done && this.byte !== 0x3e) this.at++;
    this.at++;
  }

  /**
   * The next attribute of a tag, lowercased (the HTML standard's "get an
   * attribute"), or null at the tag's ">" or the end of the bytes.
   */
  attribute(): { name: string; value: string } | null {
    while (isSpace(this.byte) || this.byte === 0x2f) this.at++;
    if (this.done || this.byte === 0x3e) return null;
    let name = "";
    let value = "";
    const add = (c: number) => String.fromCharCode(lower(c));
    // The name, up to "=", a space, "/" or ">".
    for (;;) {
      const c = this.byte;
      if (c === undefined) return null;
      if (c === 0x3d && name) break;
      if (isSpace(c)) {
        while (isSpace(this.byte)) this.at++;
        if (this.byte !== 0x3d) return this.done ? null : { name, value };
        break;
      }
      if (c === 0x2f || c === 0x3e) return { name, value };
      name += add(c);
      this.at++;
    }
    this.at++; // past "="
    while (isSpace(this.byte)) this.at++;
    const quote = this.byte;
    if (quote === 0x22 || quote === 0x27) {
      for (;;) {
        this.at++;
        const c = this.byte;
        if (c === undefined) return null;
        if (c === quote) {
          this.at++;
          return { name, value };
        }
        value += add(c);
      }
    }
    if (quote === 0x3e) return { name, value };
    for (;;) {
      const c = this.byte;
      if (c === undefined) return null;
      if (isSpace(c) || c === 0x3e) return { name, value };
      value += add(c);
      this.at++;
    }
  }
}

/**
 * The encoding a <meta> in the first PRESCAN_BYTES of `bytes` declares, or
 * null when none does (the HTML standard's "prescan a byte stream"). Comments
 * and other tags' attributes are skipped, so a "charset" in them is not taken.
 * A declared UTF-16 means UTF-8 (a page whose meta can be read as ASCII is not
 * UTF-16), and x-user-defined means windows-1252, as in a browser.
 */
export function prescanMetaCharset(bytes: Uint8Array): string | null {
  const s = new Scanner(bytes.subarray(0, PRESCAN_BYTES));
  const b = s.bytes;
  while (!s.done) {
    const at = s.at;
    if (startsWith(b, at, "<!--")) {
      s.at += 2; // "-->" may close the comment's own opening dashes, as in "<!-->"
      while (!s.done && !startsWith(b, s.at, "-->")) s.at++;
      s.at += 3;
    } else if (startsWith(b, at, "<meta") && (isSpace(b[at + 5]) || b[at + 5] === 0x2f)) {
      s.at += 6;
      const found = metaCharset(s);
      if (found) return found;
    } else if (b[at] === 0x3c && (isAlpha(b[at + 1]) || (b[at + 1] === 0x2f && isAlpha(b[at + 2])))) {
      // Another tag: its attributes are read, and dropped, so a ">" inside a
      // quoted value does not end it early.
      s.at += b[at + 1] === 0x2f ? 2 : 1;
      while (!s.done && !isSpace(s.byte) && s.byte !== 0x3e) s.at++;
      while (s.attribute()) {}
      s.at++;
    } else if (startsWith(b, at, "<!") || startsWith(b, at, "</") || startsWith(b, at, "<?")) {
      s.skipPastGreaterThan();
    } else {
      s.at++;
    }
  }
  return null;
}

/** Reads one <meta>'s attributes and returns the encoding it declares, if it declares one. */
function metaCharset(s: Scanner): string | null {
  const seen = new Set<string>();
  let gotPragma = false;
  let needPragma: boolean | null = null;
  let charset: string | null | undefined; // undefined: none yet; null: an unknown label
  for (let attr = s.attribute(); attr; attr = s.attribute()) {
    if (seen.has(attr.name)) continue;
    seen.add(attr.name);
    if (attr.name === "http-equiv") {
      if (attr.value === "content-type") gotPragma = true;
    } else if (attr.name === "content") {
      const label = charset === undefined ? charsetFromContent(attr.value) : null;
      if (label !== null) {
        charset = metaEncoding(label);
        needPragma = true;
      }
    } else if (attr.name === "charset") {
      charset = metaEncoding(attr.value);
      needPragma = false;
    }
  }
  if (needPragma === null || (needPragma && !gotPragma) || !charset) return null;
  if (charset === "utf-16be" || charset === "utf-16le") return "utf-8";
  return charset;
}

/**
 * The encoding a <meta>'s label names, x-user-defined being windows-1252, as in
 * a browser. x-user-defined is matched by its one label, since Node 22's
 * TextDecoder does not know it.
 */
function metaEncoding(label: string): string | null {
  return label.trim().toLowerCase() === "x-user-defined" ? "windows-1252" : encodingForLabel(label);
}

/**
 * Decodes an HTML body: by its byte order mark, else `headerCharset` (the
 * Content-Type header's charset, when it names an encoding TextDecoder
 * knows), else the encoding a <meta> declares, else UTF-8. `charset` is the
 * canonical name of the encoding used.
 */
export function decodeHtml(body: Uint8Array, headerCharset?: string): { html: string; charset: string } {
  const charset =
    bomEncoding(body) ??
    (headerCharset ? encodingForLabel(headerCharset) : null) ??
    prescanMetaCharset(body) ??
    "utf-8";
  // TextDecoder drops a byte order mark of its own encoding.
  return { html: new TextDecoder(charset).decode(body), charset };
}
