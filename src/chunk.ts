/**
 * Page text cut into chunks for embedding: each about CHUNK_TOKENS tokens,
 * the next starting with about CHUNK_OVERLAP of the one before, so a passage
 * that straddles a boundary is whole in one of them.
 *
 * Chunks end on paragraph and sentence boundaries where they can. A sentence
 * longer than a chunk is cut at a space, and text without spaces (Chinese,
 * Japanese, a long Greek run-on) at a character.
 *
 * Tokens are estimated from characters, by script: the model's window (e5,
 * 512 tokens with the "passage: " prefix and the title) must hold the chunk,
 * and a character of Chinese is about a token where one of English is about a
 * quarter of one.
 */

/** About this many tokens per chunk. */
export const CHUNK_TOKENS = 350;
/** About this share of a chunk is repeated at the start of the next. */
export const CHUNK_OVERLAP = 0.15;
/** At most this many chunks per page, from its start, so a huge page does not crowd out the rest. */
export const MAX_CHUNKS_PER_PAGE = 40;
/** At most this many characters of the bookmark's title go before each chunk when it is embedded. */
export const MAX_TITLE_CHARS = 150;

export interface ChunkOptions {
  tokens?: number;
  overlap?: number;
  maxChunks?: number;
}

/** Han, kana, Hangul and full-width forms: about a token a character. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/** The estimated tokens of one character (code point). */
function charTokens(char: string): number {
  if (char.charCodeAt(0) < 0x80) return 0.25;
  return WIDE.test(char) ? 1 : 0.4;
}

/** About how many tokens the model makes of `text`. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += charTokens(char);
  return tokens;
}

interface Unit {
  text: string;
  tokens: number;
  /**
   * What joins it to the unit before: a newline when it starts a paragraph, a
   * space when one was there, nothing in text without spaces.
   */
  sep: string;
}

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

/**
 * `sentence` (no leading or trailing space) in pieces of at most `max`
 * tokens: cut at the last space past the piece's middle, else at a character.
 */
function hardSplit(sentence: string, max: number, sep: string): Unit[] {
  const pieces: Unit[] = [];
  let piece = "";
  let tokens = 0;
  for (const char of sentence) {
    const t = charTokens(char);
    if (tokens + t > max && piece) {
      const space = piece.lastIndexOf(" ");
      const keep = space > piece.length / 2 ? piece.slice(0, space) : piece;
      pieces.push({ text: keep, tokens: estimateTokens(keep), sep });
      sep = keep === piece ? "" : " ";
      piece = piece.slice(keep.length).trimStart();
      tokens = estimateTokens(piece);
    }
    piece += char;
    tokens += t;
  }
  if (piece) pieces.push({ text: piece, tokens: estimateTokens(piece), sep });
  return pieces;
}

/** The text's sentences, paragraph by paragraph, none over `max` tokens. */
function units(text: string, max: number): Unit[] {
  const out: Unit[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const paragraph = block.replace(/\s+/g, " ").trim();
    if (!paragraph) continue;
    let sep = "\n";
    for (const { segment } of sentences.segment(paragraph)) {
      const sentence = segment.trim();
      if (!sentence) continue;
      const tokens = estimateTokens(sentence);
      if (tokens > max) out.push(...hardSplit(sentence, max, sep));
      else out.push({ text: sentence, tokens, sep });
      sep = segment.endsWith(" ") ? " " : "";
    }
  }
  return out;
}

function join(chunk: Unit[]): string {
  return chunk.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join("");
}

/** The end of `chunk` to repeat at the start of the next: whole sentences if they fit, else the last one's tail. */
function overlapOf(chunk: Unit[], budget: number): Unit[] {
  const tail: Unit[] = [];
  let tokens = 0;
  for (let i = chunk.length - 1; i > 0; i--) {
    if (tokens + chunk[i].tokens > budget) break;
    tail.unshift(chunk[i]);
    tokens += chunk[i].tokens;
  }
  if (tail.length > 0) return tail;
  // The last sentence alone is too long: its last `budget` tokens, from a word start if it has spaces.
  const chars = Array.from(chunk[chunk.length - 1].text);
  let start = chars.length;
  let t = 0;
  while (start > 0 && t + charTokens(chars[start - 1]) <= budget) t += charTokens(chars[--start]);
  let text = chars.slice(start).join("");
  const space = text.indexOf(" ");
  if (start > 0 && chars[start - 1] !== " " && space >= 0 && space < text.length / 2) text = text.slice(space + 1);
  text = text.trim();
  return text ? [{ text, tokens: estimateTokens(text), sep: "" }] : [];
}

/**
 * `text` in chunks of about `tokens` tokens (CHUNK_TOKENS), each starting with
 * about `overlap` (CHUNK_OVERLAP) of the one before, at most `maxChunks`
 * (MAX_CHUNKS_PER_PAGE) of them, from the start. Empty text has none.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const budget = options.tokens ?? CHUNK_TOKENS;
  const overlapBudget = budget * (options.overlap ?? CHUNK_OVERLAP);
  const maxChunks = options.maxChunks ?? MAX_CHUNKS_PER_PAGE;
  // A sentence plus the overlap before it always fits in a chunk.
  const all = units(text, budget - overlapBudget);
  const chunks: string[] = [];
  let current: Unit[] = [];
  let tokens = 0;
  // Whether `current` holds more than the overlap carried over from the chunk before.
  let fresh = false;
  for (const unit of all) {
    if (chunks.length >= maxChunks) return chunks;
    if (fresh && tokens + unit.tokens > budget) {
      chunks.push(join(current));
      current = overlapOf(current, overlapBudget);
      tokens = current.reduce((sum, u) => sum + u.tokens, 0);
      fresh = false;
    }
    current.push(unit);
    tokens += unit.tokens;
    fresh = true;
  }
  if (fresh && chunks.length < maxChunks) chunks.push(join(current));
  return chunks;
}

/** What a chunk's vector is computed from: the bookmark's title (clipped), then the chunk. */
export function chunkEmbeddingText(title: string, chunk: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  const clipped = Array.from(flat).slice(0, MAX_TITLE_CHARS).join("");
  return clipped ? `${clipped}\n${chunk}` : chunk;
}
