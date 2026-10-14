// The published package, end to end: packs the tarball `npm publish` would
// upload, unpacks it into a scratch directory and checks what `npx -y
// mnemos-mcp` gets: the compiled files and nothing else, a bin with a node
// shebang, and a server that starts through that bin and answers an MCP
// handshake. It packs (and so builds through `prepare`), so it runs from
// scripts/check-full.sh as `node --test e2e/package.e2e.js`; its name keeps
// it out of the discovery `npm test` does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bookmarks.json");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let scratch;
let packed; // npm pack --json's entry for the tarball
let pkgDir; // the unpacked package, as npm install would lay it out

before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "mnemos-pack-"));
  // `prepare`'s output goes to stderr with --json, so stdout is only the JSON.
  // With a shell (Windows) the arguments are joined unquoted, so quote the path.
  const dest = process.platform === "win32" ? `"${scratch}"` : scratch;
  const stdout = execFileSync(NPM, ["pack", "--json", "--pack-destination", dest], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32", // npm.cmd can't be spawned without a shell
  });
  [packed] = JSON.parse(stdout);
  // Relative paths and cwd: GNU tar reads `C:\...` as a remote host.
  execFileSync("tar", ["-xzf", packed.filename], { cwd: scratch });
  pkgDir = path.join(scratch, "package");
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("tarball: holds the compiled server and package.json", () => {
  const files = packed.files.map((f) => f.path);
  for (const want of ["dist/cli.js", "dist/index.js", "dist/lib.js", "dist/icon.js", "package.json"]) {
    assert.ok(files.includes(want), `${want} missing from ${files.join(", ")}`);
    assert.ok(existsSync(path.join(pkgDir, want)), `${want} not unpacked`);
  }
});

test("tarball: holds nothing from src/, test/ or e2e/", () => {
  const leaked = packed.files
    .map((f) => f.path)
    .filter((p) => /^(src|test|e2e)\//.test(p));
  assert.deepEqual(leaked, []);
});

test("tarball: the bin target is in it and starts with a node shebang", () => {
  const { bin } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(bin), ["mnemos-mcp"]);
  const target = path.normalize(bin["mnemos-mcp"]);
  assert.ok(
    packed.files.some((f) => path.normalize(f.path) === target),
    `bin target ${target} not in the tarball`,
  );
  const head = readFileSync(path.join(pkgDir, target), "utf8").split("\n")[0];
  assert.equal(head.trimEnd(), "#!/usr/bin/env node");
});

test("unpacked package: starts through its bin and answers initialize and tools/list", async () => {
  const { bin } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const binFile = path.join(pkgDir, bin["mnemos-mcp"]);
  // The repo's installed dependencies stand in for `npm install` (no network).
  // ESM ignores NODE_PATH, so link node_modules; a junction needs no admin on Windows.
  symlinkSync(path.join(ROOT, "node_modules"), path.join(pkgDir, "node_modules"), "junction");

  let command = binFile;
  let args = [];
  if (process.platform === "win32") {
    // Windows has no shebangs; npm's shim runs the bin with node.
    command = process.execPath;
    args = [binFile];
  } else {
    // The tarball stores it 0644; npm install marks bin targets executable.
    chmodSync(binFile, 0o755);
  }

  const client = new Client({ name: "mnemos-package-e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      cwd: scratch, // not the repo, so nothing resolves from it by accident
      env: {
        ...process.env,
        CHROME_BOOKMARKS_PATH: FIXTURE,
        // Its index in the scratch directory, not the user's cache, and the fake embedder, not the real model.
        MNEMOS_CACHE_DIR: path.join(scratch, "cache"),
        MNEMOS_EMBEDDER: "fake",
        // No page fetching: the fixture's URLs are real sites.
        MNEMOS_FETCH_PAGES: "0",
      },
    }),
  );
  try {
    assert.equal(client.getServerVersion().name, "mnemos");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "list_folder_contents",
      "list_folders",
      "recent_bookmarks",
      "search_bookmarks",
      "semantic_search",
      "top_domains",
    ]);
  } finally {
    await client.close();
  }
});
