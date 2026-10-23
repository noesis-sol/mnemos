// --browser default detected for real in a spawned server: the built server,
// driven with the SDK's client, runs this platform's detection command by name
// (osascript on macOS, xdg-settings on Linux), found first on PATH as a stub
// that prints a browser's answer or fails. Each test gives the server a fake
// home holding an Edge and a Brave profile, so the browsers' default paths land
// inside it and Edge, before Brave in BROWSERS order, is the fallback.
//
// Windows is skipped: execFileSync starts `reg` by name with CreateProcess,
// which looks in System32 before PATH, so a stub on PATH is never run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = path.join(ROOT, "dist", "index.js");
const SKIP = process.platform === "win32" && "reg is found in System32 before PATH, so it cannot be stubbed";

/** This platform's detection command, and the answers its stub gives. */
const COMMAND =
  process.platform === "darwin"
    ? { name: "osascript", source: "LaunchServices", brave: "com.brave.Browser", unsupported: "company.thebrowser.Browser" }
    : { name: "xdg-settings", source: "xdg-settings", brave: "brave-browser.desktop", unsupported: "org.gnome.Epiphany.desktop" };
/** The name mnemos gives the browser in COMMAND.unsupported, one it cannot read. */
const UNSUPPORTED = process.platform === "darwin" ? "Arc" : "GNOME Web";
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SELECTION_VARS = [
  "CHROME_BOOKMARKS_PATH",
  "CHROME_PROFILE",
  "MNEMOS_BOOKMARKS_PATH",
  "MNEMOS_PROFILE",
  "MNEMOS_BOOKMARKS_BROWSER",
];

const dirs = [];
// Each test closes its client, which waits for the server to exit, before this runs. A
// throwing after hook would skip the hooks after it, so a leftover directory is let be.
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a temporary directory left behind
    }
  }
});

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** A Chromium profile's Bookmarks file with one bookmark in the bookmarks bar. */
const chromiumFile = (name, url) =>
  JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "",
        children: [{ type: "url", name, url, date_added: "13350000000000000" }],
      },
    },
  });

/**
 * A fake home with an Edge and a Brave profile, and a bin directory whose stub
 * of the detection command runs `script` (a shell script's body). Returns the
 * server's environment and both profiles' Bookmarks files.
 */
function machine(script) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemos-default-browser-")));
  dirs.push(home);
  // Each browser's user-data directory: below Application Support on macOS, ~/.config on Linux.
  const profile = (mac, linux) =>
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", ...mac, "Default", "Bookmarks")
      : path.join(home, ".config", ...linux, "Default", "Bookmarks");
  const edge = profile(["Microsoft Edge"], ["microsoft-edge"]);
  const brave = profile(["BraveSoftware", "Brave-Browser"], ["BraveSoftware", "Brave-Browser"]);
  write(edge, chromiumFile("Edge rust notes", "https://edge.example/rust"));
  write(brave, chromiumFile("Brave rust notes", "https://brave.example/rust"));

  const bin = path.join(home, "bin");
  write(path.join(bin, COMMAND.name), `#!/bin/sh\n${script}\n`);
  fs.chmodSync(path.join(bin, COMMAND.name), 0o755);

  const env = { ...process.env };
  for (const name of SELECTION_VARS) delete env[name];
  Object.assign(env, {
    HOME: home,
    // No mimeapps.list on Linux but what the test writes: every XDG directory is in the fake home.
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CONFIG_DIRS: path.join(home, "etc", "xdg"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_DATA_DIRS: path.join(home, "usr", "share"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    // Index in a scratch cache with the fake embedder: never the user's cache, never the real model.
    MNEMOS_CACHE_DIR: path.join(home, "cache"),
    MNEMOS_EMBEDDER: "fake",
    // No page fetching: nothing here is a real site.
    MNEMOS_FETCH_PAGES: "0",
    TZ: "UTC",
  });
  return { home, env, edge, brave };
}

const KEYWORD_CALLS = {
  search_bookmarks: { query: "rust" },
  list_folders: {},
  list_folder_contents: { folder: "Bookmarks Bar" },
  recent_bookmarks: {},
  top_domains: {},
};

async function withServer(env, fn) {
  const client = new Client({ name: "mnemos-test", version: "0.0.0" });
  // No --browser: default is the default.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" }));
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("e2e default browser: the detection command naming Brave makes every keyword tool read Brave", { skip: SKIP }, async () => {
  const { env, brave } = machine(`echo ${COMMAND.brave}`);
  await withServer(env, async (client) => {
    const { tools } = await client.listTools();
    const keyword = tools.map((t) => t.name).filter((name) => name !== "semantic_search");
    assert.deepEqual(keyword.sort(), Object.keys(KEYWORD_CALLS).sort(), "every keyword tool is checked");
    for (const [name, args] of Object.entries(KEYWORD_CALLS)) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(data.sources, [{ browser: "brave", profile: "Default", bookmarks: brave }], name);
      assert.equal("warnings" in data, false, name);
      assert.doesNotMatch(result.content[0].text, /edge\.example/, name);
    }
    const found = JSON.parse((await client.callTool({ name: "search_bookmarks", arguments: { query: "rust" } })).content[0].text);
    assert.deepEqual(
      found.matches.map((m) => m.url),
      ["https://brave.example/rust"],
    );
  });
});

test("e2e default browser: the detection command failing reads the first browser with bookmarks, with a warning", { skip: SKIP }, async () => {
  const { home, env, edge } = machine("exit 1");
  if (process.platform === "darwin") {
    // Without osascript's answer, macOS reads LaunchServices' preferences, and
    // takes no file to mean Safari: a directory there cannot be read, so
    // detection fails.
    fs.mkdirSync(
      path.join(home, "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist"),
      { recursive: true },
    );
  }
  await withServer(env, async (client) => {
    for (const [name, args] of Object.entries(KEYWORD_CALLS)) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(data.sources, [{ browser: "edge", profile: "Default", bookmarks: edge }], name);
      assert.equal(data.warnings?.length, 1, name);
      assert.match(
        data.warnings[0],
        /^Could not detect the system default browser \(.+\); reading Edge, the first browser with bookmarks here\. Choose a browser with --browser <id>/,
        name,
      );
    }
  });
});

test("e2e default browser: the detection command naming an unsupported browser is an error naming it", { skip: SKIP }, async () => {
  const { env } = machine(`echo ${COMMAND.unsupported}`);
  await withServer(env, async (client) => {
    for (const [name, args] of Object.entries(KEYWORD_CALLS)) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name}: ${result.content[0].text}`);
      const text = result.content[0].text;
      const named = `The system default browser is ${UNSUPPORTED} (${COMMAND.unsupported}, from ${COMMAND.source}), whose bookmarks mnemos cannot read.`;
      assert.match(text, new RegExp(escape(named)), name);
      assert.match(text, /Choose a browser with --browser <id>/, name);
      assert.match(text, /Browsers with bookmarks here: edge, brave\./, name);
    }
  });
});
