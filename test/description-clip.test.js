// The description in the embedding text is clipped (clipDescription), so a
// long one cannot push the folder path and URL words past what the embedder
// reads; the store's description column keeps it whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DESCRIPTION_CHARS, bookmarkRows, clipDescription, embeddingText } from "../dist/indexer.js";

const bookmark = { title: "LiveKit Agents", folder_path: "Reading List", url: "https://github.com/livekit/agents" };

test("clipDescription: a short description is kept, on one line", () => {
  assert.equal(clipDescription("Realtime voice agents"), "Realtime voice agents");
  assert.equal(clipDescription("  Realtime\n\tvoice   agents \r\n"), "Realtime voice agents");
  assert.equal(clipDescription(""), "");
  const exact = "a".repeat(MAX_DESCRIPTION_CHARS);
  assert.equal(clipDescription(exact), exact);
});

test("clipDescription: a long description is cut at the last word boundary within the limit", () => {
  const long = "lorem ipsum ".repeat(100);
  const clipped = clipDescription(long);
  assert.ok(clipped.length <= MAX_DESCRIPTION_CHARS, `${clipped.length} chars`);
  assert.ok(clipped.length > MAX_DESCRIPTION_CHARS - 12, `${clipped.length} chars`);
  assert.match(clipped, /^(lorem ipsum )*lorem( ipsum)?$/);
  assert.ok(long.startsWith(clipped));

  // A space right after the limit keeps the whole limit.
  const words = `${"x".repeat(MAX_DESCRIPTION_CHARS - 4)} abc def`;
  assert.equal(clipDescription(words), `${"x".repeat(MAX_DESCRIPTION_CHARS - 4)} abc`);
  const atLimit = `${"y".repeat(MAX_DESCRIPTION_CHARS)} tail`;
  assert.equal(clipDescription(atLimit), "y".repeat(MAX_DESCRIPTION_CHARS));
});

test("clipDescription: one long word is cut at the limit, never inside a surrogate pair", () => {
  const word = "z".repeat(MAX_DESCRIPTION_CHARS * 2);
  assert.equal(clipDescription(word), "z".repeat(MAX_DESCRIPTION_CHARS));
  assert.equal(clipDescription(`ab ${word}`), "ab " + "z".repeat(MAX_DESCRIPTION_CHARS - 3));

  const emoji = "😀".repeat(MAX_DESCRIPTION_CHARS + 5);
  const clipped = clipDescription(emoji);
  assert.equal(Array.from(clipped).length, MAX_DESCRIPTION_CHARS);
  assert.equal(clipped, "😀".repeat(MAX_DESCRIPTION_CHARS));
  assert.doesNotMatch(clipped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("embeddingText: a long description is clipped and the folder path and URL words still follow", () => {
  const preview = "This article explains how realtime voice agents work. ".repeat(40);
  const text = embeddingText({ ...bookmark, description: preview });
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "LiveKit Agents");
  assert.equal(lines[1], clipDescription(preview));
  assert.ok(lines[1].length <= MAX_DESCRIPTION_CHARS);
  assert.deepEqual(lines.slice(2), ["Reading List", "github livekit agents"]);
  assert.ok(text.length < preview.length);
});

test("embeddingText: a description with line breaks stays one line", () => {
  assert.equal(
    embeddingText({ ...bookmark, description: "Realtime\nvoice agents" }),
    "LiveKit Agents\nRealtime voice agents\nReading List\ngithub livekit agents",
  );
});

test("bookmark rows: the stored description stays whole; its hash is of the clipped text", () => {
  const preview = "word ".repeat(200).trim();
  const [row] = bookmarkRows([
    { folder: "Reading List", node: { type: "url", name: "A", url: "https://a.example/", description: preview } },
  ]);
  assert.equal(row.description, preview);
  const [short] = bookmarkRows([
    {
      folder: "Reading List",
      node: { type: "url", name: "A", url: "https://a.example/", description: clipDescription(preview) },
    },
  ]);
  // Only the clipped part is embedded: text beyond the limit does not change the vector's text.
  assert.equal(row.text_hash, short.text_hash);
});
