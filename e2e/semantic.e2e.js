// Semantic search, end to end, the way a user gets it: packs the tarball,
// installs it with npm into a clean directory (real dependencies from the
// registry, optional ones included), starts the installed bin on a copy of a
// fixture library with a fresh cache directory and the real model, waits for
// the bookmark titles to be embedded, runs the golden queries of
// e2e/fixtures/semantic/queries.json and scores the ranking. Then it starts
// the server again on the same cache and checks nothing is embedded twice.
//
// Nothing is fake but the websites: the bookmarks point at a local fixture
// site on 127.0.0.1 (allowed through MNEMOS_FETCH_ALLOW_HOSTS), so no result
// depends on the public web. The model comes from Hugging Face; set
// MNEMOS_E2E_MODEL_CACHE to a directory to keep it there between runs (CI
// caches it). It runs from .github/workflows/semantic.yml, or by hand:
//
//   npm ci && node --test e2e/semantic.e2e.js
//
// Its name keeps it out of the discovery `npm test` does. Every run prints a
// report (per-query ranks, scores and timings), and appends it to the GitHub
// job summary when $GITHUB_STEP_SUMMARY is set, so quality drift shows even
// when the test passes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = path.join(ROOT, "e2e", "fixtures", "semantic");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
/** Bookmark URLs in the fixture start with this; the copy the server reads has the site's origin instead. */
const SITE_PLACEHOLDER = "{{site}}";

// Thresholds. On 2026-10-13 (darwin/arm64, Node 24) every must query ranked
// first and the MRR was 0.95: the top 3 and 0.8 leave room for the small
// score differences ONNX gives on other CPUs, without letting a real
// regression (no keyword boost, no folder paths in the text) through.
/** A `must` query fails unless one of its expected bookmarks ranks this high or higher. */
const TOP_K = 3;
/** The mean reciprocal rank over every ranked query must reach this. */
const MIN_MRR = 0.8;
/** First start: the model download and the title embedding must finish within this. */
const TITLES_TIMEOUT_MS = 10 * 60_000;
/** Restart: titles must be reported complete within this, with nothing to embed. */
const RESTART_READY_MS = 30_000;
/** Restart: the model must load from the cache and answer a semantic query within this. */
const RESTART_SEMANTIC_MS = 60_000;
const POLL_MS = 250;

const { queries: QUERIES } = JSON.parse(fs.readFileSync(path.join(FIXTURES, "queries.json"), "utf8"));

let scratch;
let site; // the fixture site's http.Server
let origin; // http://127.0.0.1:<port>
let bookmarksFile; // the server's copy of the fixture
let cacheDir;
let installDir;
let bin; // the installed bin: { command, args }
let bookmarkCount;
let client; // the first server, once it has finished the titles
let firstRanks; // rank per query on the first server, compared after the restart

const timings = {}; // name -> ms or a note, for the report
const rows = []; // per-query results, for the report

/** Every `url` node under the Chrome-format `roots`. */
function urlNodes(roots) {
  const out = [];
  const walk = (node) => {
    if (node.type === "url") out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of Object.values(roots)) walk(root);
  return out;
}

/** Bytes of every file under `dir`, links not followed. */
function treeSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Runs npm with the args; with a shell (Windows, for npm.cmd) the arguments are joined unquoted, so quote paths. */
function npm(args, cwd) {
  return execFileSync(NPM, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
}

function quoted(p) {
  return process.platform === "win32" ? `"${p}"` : p;
}

/** The fixture site: each bookmark's path answers a small page with its title; anything else is a 404. */
async function startSite(pages) {
  const server = http.createServer((req, res) => {
    const title = pages.get(new URL(req.url, "http://x").pathname);
    if (title === undefined) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const html = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html><html><head><meta charset="utf-8"><title>${html}</title></head><body><h1>${html}</h1></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function startServer() {
  const c = new Client({ name: "mnemos-semantic-e2e", version: "0.0.0" });
  const started = Date.now();
  await c.connect(
    new StdioClientTransport({
      ...bin,
      cwd: installDir,
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: bookmarksFile,
        MNEMOS_CACHE_DIR: cacheDir,
        MNEMOS_FETCH_ALLOW_HOSTS: new URL(origin).host,
      },
    }),
  );
  return { client: c, connectMs: Date.now() - started };
}

/** semantic_search's answer, parsed. */
async function search(c, query, options = {}) {
  const result = await c.callTool({ name: "semantic_search", arguments: { query, ...options } });
  assert.ok(!result.isError, `semantic_search failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

/** The status's counts: "titles 12/31 · pages 0/31". */
function titleCounts(status) {
  const m = /titles (\d+)\/(\d+)/.exec(status.progress);
  assert.ok(m, `no title counts in ${JSON.stringify(status)}`);
  return { done: Number(m[1]), total: Number(m[2]) };
}

/** Polls semantic_search's status until `done(status)`; every status seen goes to `seen`. */
async function waitFor(c, ms, done, seen = []) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { status } = await search(c, "status");
    seen.push(status);
    if (done(status)) return status;
    if (Date.now() > deadline) {
      assert.fail(`not done within ${seconds(ms)}; last status ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function titlesComplete(status) {
  const { done, total } = titleCounts(status);
  return status.indexing === "ready" && status.search === "semantic" && total === bookmarkCount && done === total;
}

/** 1-based rank of the first result whose URL path is expected; Infinity if none is returned. */
function rankOf(results, expect) {
  const i = results.findIndex((r) => expect.includes(new URL(r.url).pathname));
  return i === -1 ? Infinity : i + 1;
}

/** Runs every golden query and returns the rows of the report. */
async function runQueries(c) {
  const out = [];
  for (const q of QUERIES) {
    const options = {};
    if (q.folder) options.folder = q.folder;
    if (q.limit) options.limit = q.limit;
    const started = performance.now();
    const answer = await search(c, q.query, options);
    const ms = performance.now() - started;
    const results = answer.results ?? [];
    out.push({
      q,
      ms,
      answer,
      results,
      rank: q.expect ? rankOf(results, q.expect) : undefined,
    });
  }
  return out;
}

function report() {
  const lines = ["## Semantic search acceptance (titles)", ""];
  lines.push(`${os.platform()}/${os.arch()} · Node ${process.versions.node}`, "");
  lines.push("| Timing | Value |", "| --- | --- |");
  for (const [name, value] of Object.entries(timings)) lines.push(`| ${name} | ${value} |`);
  if (rows.length > 0) {
    const ranked = rows.filter((r) => r.rank !== undefined);
    const mrr = ranked.reduce((sum, r) => sum + (r.rank === Infinity ? 0 : 1 / r.rank), 0) / ranked.length;
    lines.push("", `MRR ${mrr.toFixed(3)} (min ${MIN_MRR}) · must queries need their bookmark in the top ${TOP_K}`, "");
    lines.push("| Query | Expected | Rank | Top 3 (score, matched on) | Above cutoff | ms |", "| --- | --- | --- | --- | --- | --- |");
    for (const r of rows) {
      const top = r.results
        .slice(0, 3)
        .map((x) => `${x.title} (${x.score ?? "–"}, ${x.matched_on})`)
        .join("<br>");
      const filters = [r.q.folder && `folder ${r.q.folder}`, r.q.limit && `limit ${r.q.limit}`].filter(Boolean).join(", ");
      const query = `${r.q.query}${filters ? ` (${filters})` : ""}${r.q.must ? " **must**" : ""}`;
      const expected = r.q.expect ? r.q.expect.join(", ") : `≤ ${r.q.max_results} results`;
      const rank = r.rank === undefined ? "–" : r.rank === Infinity ? "**missing**" : String(r.rank);
      const cell = (s) => String(s).replace(/\|/g, "\\|");
      lines.push(
        `| ${cell(query)} | ${cell(expected)} | ${rank} | ${cell(top || "none")} | ${r.answer.count_above_threshold} | ${r.ms.toFixed(0)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-semantic-e2e-"));
  const fixture = fs.readFileSync(path.join(FIXTURES, "Bookmarks"), "utf8");
  const nodes = urlNodes(JSON.parse(fixture).roots);
  bookmarkCount = nodes.length;
  site = await startSite(new Map(nodes.map((n) => [n.url.slice(SITE_PLACEHOLDER.length), n.name])));
  origin = `http://127.0.0.1:${site.address().port}`;
  bookmarksFile = path.join(scratch, "Bookmarks");
  fs.writeFileSync(bookmarksFile, fixture.replaceAll(SITE_PLACEHOLDER, origin));

  cacheDir = path.join(scratch, "cache");
  fs.mkdirSync(cacheDir);
  const keep = process.env.MNEMOS_E2E_MODEL_CACHE;
  if (keep) {
    // The index is fresh; only the model is reused, through a link to where it is kept.
    fs.mkdirSync(keep, { recursive: true });
    fs.symlinkSync(path.resolve(keep), path.join(cacheDir, "models"), "junction");
  }
  timings["model before the run"] = keep && treeSize(keep) > 0 ? `cached (${mb(treeSize(keep))})` : "not cached: downloads";
});

after(async () => {
  try {
    await client?.close();
  } catch {
    // already gone
  }
  site?.close();
  const text = report();
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (scratch) {
    try {
      // The link first, so the kept model is never removed through it.
      if (fs.lstatSync(path.join(cacheDir, "models")).isSymbolicLink()) fs.unlinkSync(path.join(cacheDir, "models"));
    } catch {
      // no link
    }
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

test("install: npm installs the packed tarball into a clean directory", { timeout: 15 * 60_000 }, () => {
  // `prepare` builds dist/; its output goes to stderr with --json, so stdout is only the JSON.
  const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", quoted(scratch)], ROOT));
  const tarball = path.join(scratch, packed.filename);
  timings["tarball"] = mb(fs.statSync(tarball).size);

  installDir = path.join(scratch, "install");
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "mnemos-e2e-user", private: true }));
  const started = Date.now();
  npm(["install", "--no-audit", "--no-fund", quoted(tarball)], installDir);
  timings["npm install"] = seconds(Date.now() - started);
  const modules = path.join(installDir, "node_modules");
  timings["node_modules"] = mb(treeSize(modules));

  const pkg = path.join(modules, "mnemos-mcp");
  assert.ok(!fs.lstatSync(pkg).isSymbolicLink(), "mnemos-mcp is installed, not linked");
  assert.ok(
    fs.existsSync(path.join(modules, "@huggingface", "transformers", "package.json")),
    "the optional @huggingface/transformers is installed",
  );
  const link = path.join(modules, ".bin", process.platform === "win32" ? "mnemos-mcp.cmd" : "mnemos-mcp");
  assert.ok(fs.existsSync(link), `${link} exists`);
  if (process.platform === "win32") {
    // What npm's .cmd shim runs: node on the bin target. Spawning the shim
    // itself would go through cmd.exe, which close() would end, not the server.
    const target = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).bin["mnemos-mcp"];
    bin = { command: process.execPath, args: [path.join(pkg, target)] };
  } else {
    bin = { command: link, args: [] };
  }
});

test("site: every bookmark's page is served from 127.0.0.1", async () => {
  const { roots } = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  for (const { url, name } of urlNodes(roots)) {
    assert.ok(url.startsWith(`${origin}/`), url);
    const res = await fetch(url);
    assert.equal(res.status, 200, url);
    assert.ok((await res.text()).includes("<title>"), `${name}: a page`);
  }
});

test("first start: the titles are embedded within the timeout", { timeout: TITLES_TIMEOUT_MS + 60_000 }, async () => {
  assert.ok(bin, "installed");
  const started = Date.now();
  const first = await startServer();
  timings["first start: connect"] = `${first.connectMs} ms`;
  const seen = [];
  try {
    await waitFor(first.client, TITLES_TIMEOUT_MS, titlesComplete, seen);
  } catch (err) {
    await first.client.close();
    throw err;
  }
  client = first.client;
  timings["first start: titles complete"] = seconds(Date.now() - started);
  const states = [...new Set(seen.map((s) => s.embedder.replace(/ \d+%$/, "")))];
  timings["first start: embedder states seen"] = states.join(" → ");
});

test("golden queries: every must query in the top 3, MRR at or above the minimum", async () => {
  assert.ok(client, "the server finished the titles");
  rows.push(...(await runQueries(client)));
  firstRanks = rows.map((r) => r.rank);
  timings["query latency (median)"] = `${[...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)].toFixed(0)} ms`;

  const failures = [];
  for (const r of rows) {
    const { q, answer, results, rank } = r;
    assert.equal(answer.status.search, "semantic", `${q.query}: semantic results`);
    if (q.must && !(rank <= TOP_K)) failures.push(`"${q.query}": expected ${q.expect.join(" or ")} in the top ${TOP_K}, got rank ${rank}`);
    if (q.top1 && rank !== 1) failures.push(`"${q.query}": expected ${q.expect.join(" or ")} first (keyword hit), got rank ${rank}`);
    if (q.folder) {
      const outside = results.filter((x) => !x.folder.split(" › ").includes(q.folder));
      if (outside.length > 0) failures.push(`"${q.query}" in ${q.folder}: results outside it: ${outside.map((x) => x.folder).join(", ")}`);
    }
    if (q.limit) {
      if (results.length > q.limit) failures.push(`"${q.query}" limit ${q.limit}: ${results.length} results`);
      if (answer.count_above_threshold < results.length) failures.push(`"${q.query}": count_above_threshold below the results returned`);
    }
    if (q.max_results !== undefined && answer.count_above_threshold > q.max_results) {
      failures.push(
        `"${q.query}" is unrelated, but ${answer.count_above_threshold} bookmarks cleared the cutoff: ` +
          results.map((x) => `${x.title} ${x.score}`).join(", "),
      );
    }
  }
  const ranked = rows.filter((r) => r.rank !== undefined);
  const mrr = ranked.reduce((sum, r) => sum + (r.rank === Infinity ? 0 : 1 / r.rank), 0) / ranked.length;
  if (mrr < MIN_MRR) failures.push(`MRR ${mrr.toFixed(3)} is below ${MIN_MRR}`);
  assert.deepEqual(failures, []);
});

test("restart: the titles are ready at once, nothing is embedded again, the ranking holds", { timeout: RESTART_READY_MS + RESTART_SEMANTIC_MS + 60_000 }, async () => {
  assert.ok(client && firstRanks, "the first server answered the golden queries");
  await client.close();
  client = undefined;

  const started = Date.now();
  const second = await startServer();
  client = second.client;
  timings["restart: connect"] = `${second.connectMs} ms`;
  const seen = [];
  await waitFor(client, RESTART_READY_MS, (s) => s.indexing === "ready", seen);
  timings["restart: titles ready"] = seconds(Date.now() - started);
  // The counts are taken before anything is embedded: a title to embed again would show as done < total.
  for (const status of seen) {
    const { done, total } = titleCounts(status);
    if (total > 0) assert.equal(done, total, `nothing to embed again: ${status.progress}`);
  }
  assert.deepEqual(titleCounts(seen.at(-1)), { done: bookmarkCount, total: bookmarkCount });

  await waitFor(client, RESTART_SEMANTIC_MS, (s) => s.search === "semantic");
  timings["restart: semantic results"] = seconds(Date.now() - started);
  const again = await runQueries(client);
  assert.deepEqual(
    again.map((r) => `${r.q.query}: ${r.rank}`),
    firstRanks.map((rank, i) => `${QUERIES[i].query}: ${rank}`),
  );
});
