// Semantic search, end to end, the way a user gets it: packs the tarball,
// installs it with npm into a clean directory (real dependencies from the
// registry, optional ones included), starts the installed bin on a copy of a
// fixture library with a fresh cache directory and the real model, and checks
// it in three phases:
//
// - Titles. With page fetching off, so the ranking depends on titles alone
//   and is the same from run to run: waits for the bookmark titles to be
//   embedded, runs the title queries of e2e/fixtures/semantic/queries.json and
//   scores the ranking, then starts the server again on the same cache and
//   checks nothing is embedded twice.
// - Pages. With fetching on: waits until every page is in a final state
//   (status.page_states), fetched, rendered in the headless browser where its
//   text is built by a script, and embedded. Checks each page's fetch state
//   (an article ok, a login wall needs_login, a 404 failed, a CSV, a redirect
//   to a blocked host, token-like and unsubscribe links and a bookmark in a
//   MNEMOS_SKIP_FOLDERS folder skipped), proves from the fixture site's
//   request log that the blocked and skipped URLs were never requested while
//   their titles are still found, then runs the full query set: page queries
//   must match on the page, with the topic in the snippet.
// - Freshness. Edits the Bookmarks file while the server runs (adds a
//   bookmark, then deletes one and renames one) and waits on the status for
//   the index to catch up.
//
// Nothing is fake but the websites: the bookmarks point at a local fixture
// site on 127.0.0.1 (allowed through MNEMOS_FETCH_ALLOW_HOSTS), so no result
// depends on the public web; e2e/fixtures/semantic/pages.json says what it
// serves. The model comes from Hugging Face; set MNEMOS_E2E_MODEL_CACHE to a
// directory to keep it there between runs (CI caches it). The headless
// browser is the one installed (GitHub's runners ship Chrome): in CI ($CI
// set) a missing browser fails the test; elsewhere the checks that need one
// are skipped. It runs from .github/workflows/semantic.yml, or by hand:
//
//   npm ci && node --test e2e/semantic.e2e.js
//
// Its name keeps it out of the discovery `npm test` does. Every run prints a
// report (per-query ranks, what each matched on, page states and timings),
// and appends it to the GitHub job summary when $GITHUB_STEP_SUMMARY is set,
// so quality drift shows even when the test passes.
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
/** Bookmarks in folders of this name are never fetched (MNEMOS_SKIP_FOLDERS). */
const SKIP_FOLDER = "Banking";
/** In CI the headless browser must be there; elsewhere its checks may be skipped. */
const IN_CI = Boolean(process.env.CI);

// Thresholds. On 2026-10-13 (darwin/arm64, Node 24) every must query ranked
// first and the MRR was 0.95: the top 3 and 0.8 leave room for the small
// score differences ONNX gives on other CPUs, without letting a real
// regression (no keyword boost, no folder paths in the text, no page chunks)
// through.
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
/**
 * Every page fetched (one at a time on the one domain, a second apart, most
 * of them rendered in the browser too) and embedded within this.
 */
const PAGES_TIMEOUT_MS = 10 * 60_000;
/** An edit of the Bookmarks file must be indexed within this. */
const FRESH_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

const { queries: QUERIES } = JSON.parse(fs.readFileSync(path.join(FIXTURES, "queries.json"), "utf8"));
const { pages: PAGES } = JSON.parse(fs.readFileSync(path.join(FIXTURES, "pages.json"), "utf8"));
/** The queries scored on titles alone: those that need no page. */
const TITLE_QUERIES = QUERIES.filter((q) => !q.pages);

/** Freshness: the bookmark added while the server runs, and the query that must find it by its title. */
const ADDED = {
  node: { name: "Birdwatching: identifying warblers by their song", type: "url", url: `${SITE_PLACEHOLDER}/nature/warblers` },
  folder: "Hobbies",
  query: "recognising songbirds by their calls",
};
/** Freshness: the bookmark deleted (a page with text, so its chunks go too) and the query that found it. */
const DELETED = { path: "/p/b2c4", query: "patching an inner tube on a bicycle" };
/** Freshness: the bookmark renamed, and the query that must find it by its new title. */
const RENAMED = {
  path: "/photo/aperture",
  name: "Hiking trails across Iceland's volcanoes",
  query: "walking routes near Icelandic volcanoes",
};

let scratch;
let site; // the fixture site: { server, log, titles }
let blocked; // a second server the fetch policy refuses (another port): { server, log }
let origin; // http://127.0.0.1:<port>
let bookmarksFile; // the server's copy of the fixture
let cacheDir;
let installDir;
let bin; // the installed bin: { command, args }
let bookmarkCount;
let client; // the server running now
let titlesDone = false; // the first server finished the titles
let firstRanks; // rank per title query on the first server, compared after the restart
let pagesDone = false; // every page reached a final state
let browserMissing = false; // no headless browser here (outside CI only)

const timings = {}; // name -> ms or a note, for the report
const titleRows = []; // per-query results on titles alone, for the report
const fullRows = []; // per-query results once the pages are indexed, for the report
let pageStates; // { state: [count, expected] }, for the report
const policyChecks = []; // [check, result], for the report
const freshRows = []; // [edit, query, result], for the report

/** Every `url` node under the Chrome-format `roots`, with its folder's name. */
function urlNodes(roots) {
  const out = [];
  const walk = (node, folder) => {
    if (node.type === "url") out.push({ node, folder });
    for (const child of node.children ?? []) walk(child, node.name);
  };
  for (const root of Object.values(roots)) walk(root, root.name);
  return out;
}

function pathOf(url) {
  return new URL(url).pathname;
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

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function article(page) {
  return `<article><h1>${escapeHtml(page.heading)}</h1>${page.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</article>`;
}

/** An empty shell whose script writes the article: a plain fetch finds no text in it. */
function scriptShell(page) {
  const data = JSON.stringify({ heading: page.heading, paragraphs: page.paragraphs }).replace(/</g, "\\u003c");
  return (
    `<div id="app"></div><noscript>This app needs JavaScript.</noscript><script>` +
    `const page = ${data};` +
    `const article = document.createElement("article");` +
    `const h1 = document.createElement("h1"); h1.textContent = page.heading; article.append(h1);` +
    `for (const text of page.paragraphs) { const p = document.createElement("p"); p.textContent = text; article.append(p); }` +
    `document.getElementById("app").append(article);` +
    `</script>`
  );
}

/** Starts an http server on 127.0.0.1 that logs every request's path and query before `handle` answers it. */
async function listen(handle) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push(req.url);
    handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, log };
}

/**
 * The fixture site: the pages of pages.json as their `kind` says, and for
 * every other bookmark (`titles`, path -> title) a small page with only its
 * title; anything else is a 404.
 */
async function startSite(titles, blockedOrigin) {
  const started = await listen((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    const title = titles.get(pathname);
    const page = PAGES[pathname];
    const html = (body) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(htmlPage(title ?? "", body));
    switch (page?.kind) {
      case "article":
        return html(article(page));
      case "script":
        return html(scriptShell(page));
      case "login":
        return html(
          `<h1>Sign in</h1><form method="post" action="/members/session">` +
            `<label>Email <input type="email" name="email"></label>` +
            `<label>Password <input type="password" name="password"></label>` +
            `<button>Sign in</button></form>`,
        );
      case "csv":
        return res
          .writeHead(200, { "content-type": "text/csv; charset=utf-8" })
          .end("quarter,region,sales\nQ3,North,120400\nQ3,South,98150\nQ3,East,143900\nQ3,West,87320\n");
      case "redirect-blocked":
        return res.writeHead(302, { location: `${blockedOrigin}/wiki/Main_Page` }).end();
      case "missing":
        break;
      default:
        if (title !== undefined) return html(`<h1>${escapeHtml(title)}</h1>`);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  return { ...started, titles };
}

async function startServer({ fetchPages }) {
  const c = new Client({ name: "mnemos-semantic-e2e", version: "0.0.0" });
  const env = {
    ...process.env,
    CHROME_BOOKMARKS_PATH: bookmarksFile,
    MNEMOS_CACHE_DIR: cacheDir,
    MNEMOS_FETCH_ALLOW_HOSTS: new URL(origin).host,
    MNEMOS_SKIP_FOLDERS: SKIP_FOLDER,
  };
  if (fetchPages) delete env.MNEMOS_FETCH_PAGES;
  else env.MNEMOS_FETCH_PAGES = "0";
  const started = Date.now();
  await c.connect(new StdioClientTransport({ ...bin, cwd: installDir, env }));
  return { client: c, connectMs: Date.now() - started };
}

/** semantic_search's answer, parsed. */
async function search(c, query, options = {}) {
  const result = await c.callTool({ name: "semantic_search", arguments: { query, ...options } });
  assert.ok(!result.isError, `semantic_search failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

/** The status's counts: "titles 12/31 · pages 3/31". */
function counts(status) {
  const m = /titles (\d+)\/(\d+) · pages (\d+)\/(\d+)/.exec(status.progress);
  assert.ok(m, `no counts in ${JSON.stringify(status)}`);
  return { done: Number(m[1]), total: Number(m[2]), embeddedPages: Number(m[3]), pages: Number(m[4]) };
}

function titleCounts(status) {
  const { done, total } = counts(status);
  return { done, total };
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

/** Every title of `count` bookmarks embedded. */
function titlesComplete(count) {
  return (status) => {
    const { done, total } = titleCounts(status);
    return status.indexing === "ready" && status.search === "semantic" && total === count && done === total;
  };
}

/**
 * Every page has a row and none is pending; none waits for a browser, unless
 * there is none (status.browser); and every ok page's chunks are embedded.
 */
function pagesComplete(status) {
  const { embeddedPages, pages } = counts(status);
  const states = status.page_states ?? {};
  const rows = Object.values(states).reduce((sum, n) => sum + n, 0);
  return (
    status.indexing === "ready" &&
    rows === pages &&
    !states.pending &&
    (!states.needs_browser || Boolean(status.browser)) &&
    embeddedPages === (states.ok ?? 0)
  );
}

/** The state each page must end in: pages.json's, or no_content for a page with only its title; needs_browser for those without a browser. */
function expectedStates(urls) {
  const expected = {};
  for (const url of new Set(urls)) {
    const page = PAGES[pathOf(url)];
    let state = page?.state ?? "no_content";
    if (browserMissing && (state === "no_content" || page?.kind === "script")) state = "needs_browser";
    expected[state] = (expected[state] ?? 0) + 1;
  }
  return expected;
}

/** 1-based rank of the first result whose URL path is expected; Infinity if none is returned. */
function rankOf(results, expect) {
  const i = results.findIndex((r) => expect.includes(pathOf(r.url)));
  return i === -1 ? Infinity : i + 1;
}

/** Runs the queries and returns the rows of the report. */
async function runQueries(c, queries) {
  const out = [];
  for (const q of queries) {
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
      hit: q.expect ? results.find((r) => q.expect.includes(pathOf(r.url))) : undefined,
    });
  }
  return out;
}

function mrrOf(rows) {
  const ranked = rows.filter((r) => r.rank !== undefined);
  return ranked.reduce((sum, r) => sum + (r.rank === Infinity ? 0 : 1 / r.rank), 0) / ranked.length;
}

/** What each query must do, as a list of failures: rank, keyword first, folder, limit, cutoff, page match, MRR. */
function failuresOf(rows) {
  const failures = [];
  for (const r of rows) {
    const { q, answer, results, rank, hit } = r;
    if (answer.status.search !== "semantic") failures.push(`"${q.query}": keyword results only: ${answer.status.note}`);
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
    if (hit && q.matched_on && hit.matched_on !== q.matched_on) {
      failures.push(`"${q.query}": ${hit.title} matched on ${hit.matched_on}, expected ${q.matched_on}`);
    }
    if (hit && q.snippet && !(hit.snippet ?? "").toLowerCase().includes(q.snippet.toLowerCase())) {
      failures.push(`"${q.query}": the snippet of ${hit.title} has no "${q.snippet}": ${JSON.stringify(hit.snippet)}`);
    }
  }
  const mrr = mrrOf(rows);
  if (mrr < MIN_MRR) failures.push(`MRR ${mrr.toFixed(3)} is below ${MIN_MRR}`);
  return failures;
}

/** Edits the server's copy of the Bookmarks file with `change(roots)`. */
function editBookmarks(change) {
  const data = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  change(data.roots);
  fs.writeFileSync(bookmarksFile, JSON.stringify(data, null, 3));
}

function cell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function clip(text, max = 90) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The expected hit's match: "page: <snippet>", "title: <title>" or "keyword: <title>". */
function source(hit) {
  if (!hit) return "–";
  return hit.matched_on === "page" ? `page: ${clip(hit.snippet ?? "")}` : `${hit.matched_on}: ${hit.title}`;
}

function rankText(rank) {
  return rank === undefined ? "–" : rank === Infinity ? "**missing**" : String(rank);
}

function report() {
  const lines = ["## Semantic search acceptance (titles, pages, freshness)", ""];
  lines.push(`${os.platform()}/${os.arch()} · Node ${process.versions.node}`, "");
  lines.push("| Timing | Value |", "| --- | --- |");
  for (const [name, value] of Object.entries(timings)) lines.push(`| ${name} | ${cell(value)} |`);
  if (pageStates) {
    lines.push("", "| Page state | Pages | Expected |", "| --- | --- | --- |");
    for (const [state, [n, expected]] of Object.entries(pageStates)) lines.push(`| ${state} | ${n} | ${expected} |`);
  }
  if (policyChecks.length > 0) {
    lines.push("", "| Fetch policy | Result |", "| --- | --- |");
    for (const [check, result] of policyChecks) lines.push(`| ${cell(check)} | ${cell(result)} |`);
  }
  if (titleRows.length > 0 || fullRows.length > 0) {
    const titleRank = new Map(titleRows.map((r) => [r.q, r.rank]));
    const rows = fullRows.length > 0 ? fullRows : titleRows;
    lines.push("");
    if (titleRows.length > 0) lines.push(`Titles only: MRR ${mrrOf(titleRows).toFixed(3)} over ${titleRows.length} queries.`);
    if (fullRows.length > 0) lines.push(`With pages: MRR ${mrrOf(fullRows).toFixed(3)} over ${fullRows.length} queries.`);
    lines.push(`Minimum MRR ${MIN_MRR}; must queries need their bookmark in the top ${TOP_K}.`, "");
    lines.push(
      "| Query | Expected | Rank (titles) | Rank (pages) | Expected hit: matched on | Top 3 (score, matched on) | Above cutoff | ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const r of rows) {
      const top = r.results
        .slice(0, 3)
        .map((x) => `${x.title} (${x.score ?? "–"}, ${x.matched_on})`)
        .join("<br>");
      const filters = [r.q.folder && `folder ${r.q.folder}`, r.q.limit && `limit ${r.q.limit}`].filter(Boolean).join(", ");
      const query = `${r.q.query}${filters ? ` (${filters})` : ""}${r.q.must ? " **must**" : ""}`;
      const expected = r.q.expect ? r.q.expect.join(", ") : `≤ ${r.q.max_results} results`;
      const ranks = fullRows.length > 0 ? [rankText(titleRank.get(r.q)), rankText(r.rank)] : [rankText(r.rank), "–"];
      lines.push(
        `| ${cell(query)} | ${cell(expected)} | ${ranks[0]} | ${ranks[1]} | ${cell(source(r.hit))} | ${cell(top || "none")} | ${r.answer.count_above_threshold} | ${r.ms.toFixed(0)} |`,
      );
    }
  }
  if (freshRows.length > 0) {
    lines.push("", "| Freshness edit | Query | Result |", "| --- | --- | --- |");
    for (const [edit, query, result] of freshRows) lines.push(`| ${cell(edit)} | ${cell(query)} | ${cell(result)} |`);
  }
  return lines.join("\n") + "\n";
}

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-semantic-e2e-"));
  const fixture = fs.readFileSync(path.join(FIXTURES, "Bookmarks"), "utf8");
  const nodes = urlNodes(JSON.parse(fixture).roots);
  bookmarkCount = nodes.length;
  blocked = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(htmlPage("Wiki", "<h1>Internal wiki</h1>"));
  });
  site = await startSite(
    new Map(nodes.map(({ node }) => [pathOf(node.url.replace(SITE_PLACEHOLDER, "http://x")), node.name])),
    `http://127.0.0.1:${blocked.server.address().port}`,
  );
  origin = `http://127.0.0.1:${site.server.address().port}`;
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
  site?.server.close();
  blocked?.server.close();
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
  for (const optional of [["@huggingface", "transformers"], ["playwright-core"]]) {
    assert.ok(fs.existsSync(path.join(modules, ...optional, "package.json")), `the optional ${optional.join("/")} is installed`);
  }
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

test("site: the fixture site serves each page as pages.json says", async () => {
  const { roots } = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  try {
    for (const { node } of urlNodes(roots)) {
      assert.ok(node.url.startsWith(`${origin}/`), node.url);
      const page = PAGES[pathOf(node.url)];
      if (page?.fetched === false) continue; // never requested, not even here
      const res = await fetch(node.url, { redirect: "manual" });
      const body = await res.text();
      switch (page?.kind) {
        case "missing":
          assert.equal(res.status, 404, node.url);
          break;
        case "redirect-blocked":
          assert.equal(res.status, 302, node.url);
          assert.ok(res.headers.get("location").startsWith(`http://127.0.0.1:${blocked.server.address().port}/`), node.url);
          break;
        case "csv":
          assert.match(res.headers.get("content-type"), /^text\/csv/, node.url);
          break;
        case "script":
          assert.ok(!body.includes(`<p>${escapeHtml(page.paragraphs[0])}`), "the shell has no text but its script's");
          break;
        default:
          assert.equal(res.status, 200, node.url);
          assert.ok(body.includes(`<title>${escapeHtml(node.name)}</title>`), `${node.name}: its page`);
      }
    }
  } finally {
    // The log is mnemos's alone from here on.
    site.log.length = 0;
  }
});

test("first start: the titles are embedded within the timeout", { timeout: TITLES_TIMEOUT_MS + 60_000 }, async () => {
  assert.ok(bin, "installed");
  const started = Date.now();
  // Fetching off: the title phase ranks on titles alone, the same every run.
  const first = await startServer({ fetchPages: false });
  client = first.client;
  timings["first start: connect"] = `${first.connectMs} ms`;
  const seen = [];
  await waitFor(client, TITLES_TIMEOUT_MS, titlesComplete(bookmarkCount), seen);
  titlesDone = true;
  timings["first start: titles complete"] = seconds(Date.now() - started);
  const states = [...new Set(seen.map((s) => s.embedder.replace(/ \d+%$/, "")))];
  timings["first start: embedder states seen"] = states.join(" → ");
});

test("golden queries on titles: every must query in the top 3, MRR at or above the minimum", async () => {
  assert.ok(titlesDone, "the server finished the titles");
  titleRows.push(...(await runQueries(client, TITLE_QUERIES)));
  firstRanks = titleRows.map((r) => r.rank);
  timings["query latency (median)"] = `${[...titleRows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(titleRows.length / 2)].toFixed(0)} ms`;
  assert.deepEqual(failuresOf(titleRows), []);
});

test("restart: the titles are ready at once, nothing is embedded again, the ranking holds", { timeout: RESTART_READY_MS + RESTART_SEMANTIC_MS + 60_000 }, async () => {
  assert.ok(firstRanks, "the first server answered the golden queries");
  await client.close();
  client = undefined;

  const started = Date.now();
  const second = await startServer({ fetchPages: false });
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
  const again = await runQueries(client, TITLE_QUERIES);
  assert.deepEqual(
    again.map((r) => `${r.q.query}: ${r.rank}`),
    firstRanks.map((rank, i) => `${TITLE_QUERIES[i].query}: ${rank}`),
  );
});

test("pages: every page is fetched, rendered where it needs a browser, and embedded, into the state pages.json says", { timeout: PAGES_TIMEOUT_MS + 60_000 }, async () => {
  assert.ok(titlesDone, "the titles are indexed");
  await client?.close();
  client = undefined;
  const started = Date.now();
  const third = await startServer({ fetchPages: true });
  client = third.client;
  const seen = [];
  const last = await waitFor(client, PAGES_TIMEOUT_MS, pagesComplete, seen);
  timings["pages: complete"] = seconds(Date.now() - started);
  const fetching = [...new Set(seen.map((s) => s.fetching))];
  timings["pages: fetcher states seen"] = fetching.join(" → ");
  if (last.browser) {
    // "N pages need a browser; set MNEMOS_BROWSER": none was found.
    timings["pages: headless browser"] = `none: ${last.browser}`;
    assert.ok(!IN_CI, `no headless browser in CI: ${last.browser}`);
    browserMissing = true;
  } else {
    timings["pages: headless browser"] = "rendered the JavaScript-only pages";
  }

  const { roots } = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  const expected = expectedStates(urlNodes(roots).map(({ node }) => node.url));
  const states = last.page_states;
  pageStates = {};
  for (const state of new Set([...Object.keys(expected), ...Object.keys(states)])) {
    pageStates[state] = [states[state] ?? 0, expected[state] ?? 0];
  }
  pagesDone = true;
  assert.deepEqual(states, expected);
});

test("fetch policy: blocked and skipped URLs were never requested, and their titles are still found", async () => {
  assert.ok(pagesDone, "every page is in a final state");
  const requested = new Set(site.log.map((url) => new URL(url, "http://x").pathname));
  const { roots } = JSON.parse(fs.readFileSync(bookmarksFile, "utf8"));
  const failures = [];
  for (const { node } of urlNodes(roots)) {
    const page = PAGES[pathOf(node.url)];
    if (!page) continue;
    const label = `${node.name} (${new URL(node.url).pathname}${new URL(node.url).search})`;
    if (page.fetched === false) {
      const asked = requested.has(pathOf(node.url));
      policyChecks.push([`${label}: ${page.why}`, asked ? "**requested**" : "never requested"]);
      if (asked) failures.push(`${label} was requested: ${page.why}`);
    } else if (!requested.has(pathOf(node.url))) {
      failures.push(`${label} was never requested, but its state comes from fetching it`);
    }
    if (page.state !== "ok") {
      // Not fetched, or no text: the title still finds the bookmark.
      const { results } = await search(client, node.name);
      const hit = results.find((r) => r.url === node.url);
      if (!hit) failures.push(`${label}: not found by its title, "${node.name}"`);
      else if (hit.matched_on === "page") failures.push(`${label}: matched on a page it should not have`);
    }
  }
  policyChecks.push(["the redirect's target, on the blocked host", blocked.log.length === 0 ? "never requested" : `**requested**: ${blocked.log.join(", ")}`]);
  policyChecks.push(["requests to the fixture site", String(site.log.length)]);
  if (blocked.log.length > 0) failures.push(`the blocked host was requested: ${blocked.log.join(", ")}`);
  assert.deepEqual(failures, []);
});

test("golden queries with pages: every must query in the top 3, page queries matched on the page, MRR over the full set", async () => {
  assert.ok(pagesDone, "every page is in a final state");
  // Without a browser (outside CI only), the JavaScript-only page has no text to find.
  const queries = QUERIES.filter((q) => !(q.browser && browserMissing));
  fullRows.push(...(await runQueries(client, queries)));
  assert.deepEqual(failuresOf(fullRows), []);
});

test("freshness: an added bookmark is found, a deleted one is gone, a renamed one is found by its new title", { timeout: 2 * FRESH_TIMEOUT_MS + 60_000 }, async () => {
  assert.ok(pagesDone, "every page is in a final state");
  const added = { ...ADDED.node, url: ADDED.node.url.replace(SITE_PLACEHOLDER, origin) };
  site.titles.set(pathOf(added.url), added.name);

  // Added: one bookmark more, so the status shows when it is indexed.
  let started = Date.now();
  editBookmarks((roots) => {
    const folder = roots.bookmark_bar.children.find((c) => c.name === ADDED.folder);
    folder.children.push({ date_added: "13399000000000000", guid: "0f6c3f58-2b1e-4d0e-9a52-7c1d2e3f4a5b", id: "900", ...added });
  });
  await waitFor(client, FRESH_TIMEOUT_MS, titlesComplete(bookmarkCount + 1));
  timings["freshness: added indexed"] = seconds(Date.now() - started);
  const addedAnswer = await search(client, ADDED.query);
  const addedRank = rankOf(addedAnswer.results, [pathOf(added.url)]);
  freshRows.push([`added "${added.name}"`, ADDED.query, `rank ${rankText(addedRank)}`]);

  // Deleted and renamed in one edit: one bookmark fewer again, so the status shows when both are indexed.
  started = Date.now();
  editBookmarks((roots) => {
    const walk = (node) => {
      if (node.children) node.children = node.children.filter((c) => !(c.type === "url" && pathOf(c.url) === DELETED.path));
      if (node.type === "url" && pathOf(node.url) === RENAMED.path) node.name = RENAMED.name;
      for (const child of node.children ?? []) walk(child);
    };
    for (const root of Object.values(roots)) walk(root);
  });
  await waitFor(client, FRESH_TIMEOUT_MS, titlesComplete(bookmarkCount));
  timings["freshness: deleted and renamed indexed"] = seconds(Date.now() - started);
  const deletedAnswer = await search(client, DELETED.query);
  const deletedRank = rankOf(deletedAnswer.results, [DELETED.path]);
  freshRows.push([`deleted ${DELETED.path}`, DELETED.query, deletedRank === Infinity ? "gone" : `**still rank ${deletedRank}**`]);
  const renamedAnswer = await search(client, RENAMED.query);
  const renamedRank = rankOf(renamedAnswer.results, [RENAMED.path]);
  const renamed = renamedAnswer.results.find((r) => pathOf(r.url) === RENAMED.path);
  freshRows.push([`renamed ${RENAMED.path} to "${RENAMED.name}"`, RENAMED.query, `rank ${rankText(renamedRank)}${renamed ? `, ${source(renamed)}` : ""}`]);

  assert.ok(addedRank <= TOP_K, `the added bookmark ranks ${addedRank} for "${ADDED.query}"`);
  assert.equal(deletedRank, Infinity, `the deleted bookmark is still found for "${DELETED.query}"`);
  assert.ok(renamedRank <= TOP_K, `the renamed bookmark ranks ${renamedRank} for "${RENAMED.query}"`);
  assert.equal(renamed.title, RENAMED.name);
  assert.notEqual(renamed.matched_on, "page", "found by its title: its page has no text");
});
