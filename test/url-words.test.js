// The words of a bookmark's URL that go into its embedding text, and that
// text itself: urlWords and embeddingText from dist/indexer.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddingText, textHash, urlWords } from "../dist/indexer.js";

test("url words: host without www and TLD, then path segments", () => {
  assert.equal(urlWords("https://github.com/livekit/agents"), "github livekit agents");
  assert.equal(urlWords("https://www.example.com/"), "example");
  assert.equal(urlWords("https://docs.anthropic.com/en/docs/welcome"), "docs anthropic en welcome");
});

test("url words: the query string and fragment are dropped", () => {
  assert.equal(urlWords("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42"), "youtube watch");
  assert.equal(urlWords("https://example.com/guide?utm_source=newsletter#install"), "example guide");
});

test("url words: path segments split on - _ . and camelCase", () => {
  assert.equal(
    urlWords("https://example.org/blog/my-first_post.v2/camelCaseWords"),
    "example blog my first post v2 camel case words",
  );
  assert.equal(urlWords("https://example.org/HTMLParser"), "example html parser");
});

test("url words: page extensions and percent-encoding", () => {
  assert.equal(urlWords("https://example.org/docs/getting-started.html"), "example docs getting started");
  assert.equal(urlWords("https://example.org/wiki/Caf%C3%A9_au_lait"), "example wiki café au lait");
  assert.equal(urlWords("https://example.org/bad%E0%A4%A"), "example bad e0 a4 a", "malformed escapes split as they are");
});

test("url words: IDN hosts in Unicode, as top_domains shows them", () => {
  // The fixture's IDN bookmark, stored as punycode.
  assert.equal(urlWords("https://www.xn--mxahbxey0c.gr/"), "εχαμπλε");
  assert.equal(urlWords("https://xn--fsqu00a.xn--0zwm56d/路径"), "例子 路径");
  assert.equal(urlWords("https://例子.测试/"), "例子");
  assert.equal(urlWords("https://www.ελληνικά.gr/άρθρα"), "ελληνικά άρθρα");
});

test("url words: country second-level domains go with the TLD", () => {
  assert.equal(urlWords("https://www.bbc.co.uk/news"), "bbc news");
  assert.equal(urlWords("https://example.com.au/"), "example");
  assert.equal(urlWords("https://blog.example.de/"), "blog example");
});

test("url words: hosts with no words", () => {
  assert.equal(urlWords("http://localhost:3000/dashboard"), "localhost dashboard");
  assert.equal(urlWords("http://192.168.1.1/admin"), "admin");
  assert.equal(urlWords("http://[::1]:8080/status"), "status");
});

test("url words: non-web URLs and junk give none", () => {
  assert.equal(urlWords("javascript:alert(document.title)"), "");
  assert.equal(urlWords("chrome://settings/"), "");
  assert.equal(urlWords("data:text/html,<h1>hi</h1>"), "");
  assert.equal(urlWords("not a url"), "");
  assert.equal(urlWords(""), "");
});

test("url words: each word once, ids dropped, at most 32", () => {
  assert.equal(urlWords("https://github.com/github/github"), "github");
  const id = "a".repeat(41);
  assert.equal(urlWords(`https://example.com/p/${id}/view`), "example p view");
  const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join("/");
  assert.equal(urlWords(`https://example.com/${long}`).split(" ").length, 32);
});

test("embedding text: title, folder path and URL words, a line each", () => {
  const bookmark = { title: "  LiveKit Agents ", folder_path: "Bookmarks Bar › AI", url: "https://github.com/livekit/agents" };
  assert.equal(embeddingText(bookmark), "LiveKit Agents\nBookmarks Bar › AI\ngithub livekit agents");
  assert.equal(embeddingText({ title: "", folder_path: "Other", url: "javascript:void(0)" }), "Other");
  assert.match(textHash(embeddingText(bookmark)), /^[0-9a-f]{64}$/);
  assert.notEqual(textHash("a"), textHash("b"));
});
