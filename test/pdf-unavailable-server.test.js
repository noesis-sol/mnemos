// The server with unpdf uninstalled: spawned with a --import resolve hook
// that makes "unpdf" unresolvable (as test/embedder.test.js does for
// @huggingface/transformers), over MCP, with MNEMOS_EMBEDDER=fake and a
// node:http fixture site on 127.0.0.1. The server starts and answers; an HTML
// bookmark reaches ok; a PDF bookmark is fetched without application/pdf in
// its Accept header and ends skipped (not failed) in status.page_states; and
// semantic_search still finds the HTML page's text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { indexFile } from "../dist/index-store.js";
import { makePdf } from "./fixtures/make-pdf.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-pdf-unavailable-"));
  dirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Writes a module that, preloaded with --import, makes unpdf unresolvable. */
function blockUnpdf(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hooks = path.join(dir, "hooks.mjs");
  fs.writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
  if (specifier === "unpdf" || specifier.startsWith("unpdf/")) {
    throw Object.assign(new Error("Cannot find package 'unpdf' (blocked by test)"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  }
  return next(specifier, context);
}
`,
  );
  const register = path.join(dir, "register.mjs");
  fs.writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
  );
  return register;
}

/** A node:http server on 127.0.0.1 serving `files` (path to [type, body]), recording each request's Accept. */
async function fixtureSite(files) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    requests.push({ path: pathname, accept: req.headers.accept ?? "" });
    const file = files[pathname];
    if (!file) return res.writeHead(404).end("no such page");
    res.writeHead(200, { "Content-Type": file[0] }).end(file[1]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    host,
    requests,
    url: (p) => `http://${host}${p}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function article(title, word) {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>The ${word} orchard, visit ${i}: the ${word} orchard keeps its keeper busy all year.</p>`);
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paragraphs.join("")}</article></body></html>`;
}

/** Chrome's date_added for `n` seconds after a fixed day in 2022. */
const chromeTime = (n) => String(13_300_000_000_000_000 + n * 1_000_000);

test("the hook makes unpdf unresolvable, so pdfSupport reports it unavailable", () => {
  const register = blockUnpdf(path.join(tempDir(), "hook"));
  const script = `
    import { pdfSupport } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "dist", "pdf.js")).href)};
    console.log(JSON.stringify(await pdfSupport()));
  `;
  const out = execFileSync(process.execPath, ["--import", pathToFileURL(register).href, "--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const support = JSON.parse(out);
  assert.equal(support.available, false);
  assert.match(support.reason, /blocked by test/);
});

test("e2e: with unpdf unresolvable the server answers, HTML reaches ok, a PDF is skipped unrequested as PDF", async () => {
  const site = await fixtureSite({
    "/paper": ["application/pdf", Buffer.from(makePdf([["Quokka burrows and wombat tunnels compared."]]))],
    "/coast": ["text/html; charset=utf-8", article("Coast notes", "lighthouse")],
  });
  const dir = tempDir();
  const register = blockUnpdf(path.join(dir, "hook"));
  const cache = path.join(dir, "cache");
  const bookmarks = path.join(dir, "Bookmarks");
  const children = [
    { type: "url", name: "Seaside reading", url: site.url("/coast"), date_added: chromeTime(0) },
    { type: "url", name: "Field study", url: site.url("/paper"), date_added: chromeTime(1) },
  ];
  const folder = (name, kids = []) => ({ type: "folder", name, children: kids });
  fs.writeFileSync(
    bookmarks,
    JSON.stringify({ checksum: "x", version: 1, roots: { bookmark_bar: folder("Bookmarks bar", children), other: folder("Other bookmarks"), synced: folder("Mobile bookmarks") } }),
  );
  const client = new Client({ name: "mnemos-pdf-unavailable", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", pathToFileURL(register).href, path.join(ROOT, "dist", "index.js")],
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: bookmarks,
        MNEMOS_CACHE_DIR: cache,
        MNEMOS_EMBEDDER: "fake",
        MNEMOS_FETCH_ALLOW_HOSTS: site.host,
        MNEMOS_FETCH_PAGES: "",
        MNEMOS_BROWSER: "0",
      },
      stderr: "ignore",
    }),
  );
  try {
    // The server starts and answers.
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "semantic_search"));
    const keyword = await client.callTool({ name: "search_bookmarks", arguments: { query: "field study" } });
    assert.ok(!keyword.isError, keyword.content[0].text);
    assert.equal(JSON.parse(keyword.content[0].text).total_matches, 1);

    // Both pages fetched: the HTML page ok, the PDF skipped as not-html, unread.
    const rows = await until(() => {
      const db = new DatabaseSync(indexFile(bookmarks, cache));
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const all = new Map(db.prepare("SELECT url, status, reason, text FROM pages").all().map((r) => [r.url, r]));
        const done = (p) => {
          const status = all.get(site.url(p))?.status;
          return status && status !== "pending";
        };
        return done("/coast") && done("/paper") ? all : null;
      } catch {
        return null; // the index not created yet
      } finally {
        db.close();
      }
    }, "both pages to be fetched");
    assert.equal(rows.get(site.url("/coast")).status, "ok");
    assert.match(rows.get(site.url("/coast")).text, /lighthouse orchard/);
    const paper = rows.get(site.url("/paper"));
    assert.equal(paper.status, "skipped", `the PDF is skipped, not failed: ${paper.reason}`);
    assert.equal(paper.reason, "not-html");
    assert.equal(paper.text, null);

    const paperRequests = site.requests.filter((r) => r.path === "/paper");
    assert.ok(paperRequests.length >= 1);
    for (const r of paperRequests) assert.doesNotMatch(r.accept, /application\/pdf/, "a PDF is not asked for as a PDF");
    const coastRequests = site.requests.filter((r) => r.path === "/coast");
    assert.ok(coastRequests.length >= 1);
    for (const r of coastRequests) assert.doesNotMatch(r.accept, /application\/pdf/);

    // semantic_search still answers, finds the HTML page's text, and counts the PDF skipped.
    const data = await until(async () => {
      const result = await client.callTool({ name: "semantic_search", arguments: { query: "lighthouse orchard keeper" } });
      assert.ok(!result.isError, result.content[0].text);
      const d = JSON.parse(result.content[0].text);
      return d.results.some((r) => r.matched_on === "page" && r.url === site.url("/coast")) ? d : null;
    }, "the HTML page's chunks to be embedded");
    assert.equal(data.results[0].url, site.url("/coast"));
    assert.equal(data.results[0].matched_on, "page");
    assert.deepEqual(data.status.page_states, { ok: 1, skipped: 1 });
    assert.equal(data.status.page_states.failed, undefined, "the PDF is not counted failed");
  } finally {
    await client.close();
    await site.close();
  }
});
