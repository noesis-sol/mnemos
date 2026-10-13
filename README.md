<div align="center">

# 🧠 mnemos

**Your bookmarks are a map of what you value. Let your AI read the map.**

*mnemos* (from the Greek **μνήμη** — memory) is a local, read-only
[MCP](https://modelcontextprotocol.io) server that gives AI assistants access to your
browser bookmarks (Chrome, Edge, Brave, Vivaldi, Chromium, Firefox or Safari) — not as a pile of links, but as a curated signal of what you
consider important, which sources you trust, and which opinions you endorse.

[![npm](https://img.shields.io/npm/v/mnemos-mcp?logo=npm&color=CB3837)](https://www.npmjs.com/package/mnemos-mcp)
[![CI](https://github.com/noesis-sol/mnemos/actions/workflows/ci.yml/badge.svg)](https://github.com/noesis-sol/mnemos/actions/workflows/ci.yml)
[![Node 22.13+](https://img.shields.io/badge/node-22.13+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-8A2BE2)](https://modelcontextprotocol.io)
[![Local only](https://img.shields.io/badge/data-never%20leaves%20your%20machine-2ea44f)]()
[![Read-only](https://img.shields.io/badge/access-read--only-lightgrey)]()

</div>

---

## Why

Every bookmark is a deliberate act: *this mattered enough to keep.* Folder names
are your personal taxonomy. Frequently bookmarked domains are your trusted
sources. Recent additions are what you're thinking about *right now*.

mnemos hands that context to your AI assistant, so instead of generic answers you get:

> *"Based on your bookmarks, you've been deep in agentic engineering lately —
> here's how this connects to the LiveKit material you saved…"*

## How it works

```mermaid
flowchart LR
    A[Browser bookmarks file] -->|read-only| B[mnemos]
    B -->|MCP over stdio| C[Claude Code / Claude Desktop / any MCP client]
    C --> D{{"What does the user care about?"}}
```

mnemos reads your browser's bookmarks directly from disk on every call — always
fresh, no sync, no writes, no network. Chromium-based browsers keep a `Bookmarks`
JSON file; Firefox keeps a `places.sqlite` database, which it locks while it runs,
so mnemos copies it to a temporary directory, reads the copy and keeps the result
in memory until the database changes; Safari keeps a binary `Bookmarks.plist`.
It speaks MCP over stdio, so it works with any MCP client.

## Tools

| Tool | What it tells your assistant |
|------|------------------------------|
| 🔍 `search_bookmarks(query, folder?, limit?)` | Has the user saved material on this topic? Every query word must match the title, URL, folder path or description, at the start of a word — `kubernet` finds *Kubernetes*, `ai` doesn't match *Gmail*. |
| 🗂 `list_folders()` | The user's own taxonomy of interests — every folder, with direct and subtree counts. |
| 📁 `list_folder_contents(folder, limit?)` | Everything saved under a topic (whole-word folder matching, subfolders included). |
| 🕐 `recent_bookmarks(limit?)` | What the user is focused on right now, newest first. |
| 🌐 `top_domains(limit?)` | The sources the user trusts and returns to, ranked by bookmark count. |

Bookmarks carry a `description` where the browser stores one: Vivaldi's bookmark
descriptions, Firefox's (the one typed in older Firefox's bookmark dialog, else the
page's own description Firefox saved), and the preview text of Safari's Reading List.

Every tool that can truncate reports a `total_matches` count, so the assistant
always knows when it is looking at a partial list. Defaults return up to 100
items (hard cap 200; `top_domains` defaults to 25, cap 100).

## Quick start

Requires Node 22.13+ (macOS, Windows, or Linux). No clone, no setup — `npx` fetches and runs it:

**Claude Code**

```sh
claude mcp add --scope user mnemos -- npx -y mnemos-mcp
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "npx",
      "args": ["-y", "mnemos-mcp"]
    }
  }
}
```

Then ask things like:

- *"Based on my bookmarks, what am I currently interested in?"*
- *"Have I saved anything about MCP servers?"*
- *"Which sources do I trust for finance?"*

## Configuration

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `MNEMOS_BOOKMARKS_BROWSER` | `chrome` | Browser to read: `chrome`, `chromium`, `edge`, `brave`, `vivaldi`, `firefox` or `safari` |
| `CHROME_PROFILE` | `Default` | Profile directory name (e.g. `Profile 3`); for Firefox, the profile's name (default: the one Firefox opens) |
| `CHROME_BOOKMARKS_PATH` | — | Absolute path to any supported bookmarks file (`Bookmarks`, `places.sqlite` or `Bookmarks.plist`); overrides the two above |
| `MNEMOS_INSTALL_RUNTIME` | — | `0` keeps mnemos from installing its embedding runtime on first start; `semantic_search` then matches keywords only |

For example, `claude mcp add --scope user mnemos -e MNEMOS_BOOKMARKS_BROWSER=firefox -- npx -y mnemos-mcp`.

Semantic search runs a local embedding model through
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers),
which with ONNX Runtime weighs about 490 MB. So that `npx` starts mnemos within
your MCP client's start timeout, it is not part of the package: on first start,
after connecting, mnemos installs it with npm into its cache directory
(`~/Library/Caches/mnemos/runtime` on macOS, `%LOCALAPPDATA%\mnemos\Cache\runtime`
on Windows, `~/.cache/mnemos/runtime` on Linux) and then downloads the model
(about 120 MB). Until both are there, `semantic_search` matches keywords and
says why.

> Chrome profiles live in `~/Library/Application Support/Google/Chrome` (macOS),
> `%LOCALAPPDATA%\Google\Chrome\User Data` (Windows), and
> `~/.config/google-chrome` (Linux). Directory names are `Default`,
> `Profile 1`, `Profile 2`, … — **not** the display names you see in
> Chrome's UI.

| Browser | macOS | Windows | Linux |
|---------|-------|---------|-------|
| Edge | `~/Library/Application Support/Microsoft Edge` | `%LOCALAPPDATA%\Microsoft\Edge\User Data` | `~/.config/microsoft-edge` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser` | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` | `~/.config/BraveSoftware/Brave-Browser` |
| Vivaldi | `~/Library/Application Support/Vivaldi` | `%LOCALAPPDATA%\Vivaldi\User Data` | `~/.config/vivaldi` |
| Chromium | `~/Library/Application Support/Chromium` | `%LOCALAPPDATA%\Chromium\User Data` | `~/.config/chromium` |
| Firefox | `~/Library/Application Support/Firefox` | `%APPDATA%\Mozilla\Firefox` | `~/.mozilla/firefox`, `~/.config/mozilla/firefox`, Snap or Flatpak |
| Safari | `~/Library/Safari/Bookmarks.plist` | — | — |

> **Firefox** needs Node 22.13 or later (mnemos reads `places.sqlite` with
> `node:sqlite`). Profiles are those listed in `profiles.ini`.
>
> **Safari**: macOS lets only apps with *Full Disk Access* read Safari's
> bookmarks. Add the app that runs mnemos — your terminal for Claude Code, or
> Claude Desktop — in System Settings › Privacy & Security › Full Disk Access.

If the profile has no bookmarks file, mnemos tells the assistant which profiles
do — no cryptic tracebacks.

### Page fetching

For semantic search over page contents, mnemos fetches the pages you
bookmarked in the background, after it has indexed their titles, and keeps
their readable text (extracted with Mozilla's Readability) in its local index
([`src/fetcher.ts`](src/fetcher.ts)). The first `semantic_search` answer after
it starts says so once. Newest bookmarks go first, at most 4 fetches at a time,
one at a time per site with a second between them. When several MCP clients
each run mnemos, only one of them fetches. A page behind a login is noted as
such and not retried; a page that fails is retried later, waiting an hour, then
twice as long each time, up to a week. Set `MNEMOS_FETCH_PAGES=0` to turn all
of it off.

A page that needs JavaScript to show anything is loaded again in a headless
browser you already have — Chrome, Edge, Chromium or Brave, or the one
`MNEMOS_BROWSER` points to — with a fresh temporary profile (never yours),
no images, media or fonts, and the same policy as below for every request
it makes ([`src/headless.ts`](src/headless.ts)). mnemos downloads no browser:
without one, `semantic_search`'s status says how many pages need one.

Every fetch follows a fixed policy ([`src/fetch.ts`](src/fetch.ts)):

- **Web pages only.** `http:` and `https:` URLs; `http://` is tried as
  `https://` first and falls back to plain http only when the TLS handshake or
  the connection fails, never on an HTTP error.
- **Never your network.** Loopback, private, link-local and unspecified
  addresses (IPv4 and IPv6, IPv4-mapped included) and `.local` / `.localhost`
  names are refused, checked on every address a name resolves to, and the
  connection goes to the address that was checked.
- **No secrets or actions.** URLs whose query carries a token, key, signature,
  code, session, password or secret, or whose path looks like unsubscribe,
  logout, delete, confirm, verify, magic-link or activate, are never fetched.
- **Bounded.** At most 5 redirects, each re-checked against these rules; 15 s
  and 5 MB per page; HTML (`text/html`, `application/xhtml+xml`) only.
- **Polite.** It sends a browser User-Agent and your locale's
  `Accept-Language`, because it fetches what you saved the way your browser
  would. For the same reason it does **not** read `robots.txt`: mnemos does not
  crawl or follow links, it opens your own bookmarks one at a time. A `403` or
  `429` is taken as a refusal and not retried until a backoff allows it.

| Environment variable | Purpose |
|----------------------|---------|
| `MNEMOS_FETCH_PAGES` | `0` turns off fetching bookmarked pages; search then uses titles only |
| `MNEMOS_SKIP_DOMAINS` | Comma-separated domains never fetched; each also covers its subdomains |
| `MNEMOS_SKIP_FOLDERS` | Comma-separated folder names (whole-word, like `list_folder_contents`) whose pages are never fetched; their titles are still searchable |
| `MNEMOS_BROWSER` | Path to a Chromium-based browser for pages that need JavaScript (default: an installed Chrome, Edge, Chromium or Brave); `0` turns this off |
| `MNEMOS_FETCH_ALLOW_HOSTS` | Comma-separated `host` or `host:port` exempt from the private-address block, e.g. an intranet wiki |

## Privacy & design

- **Read-only.** mnemos never modifies your bookmarks file.
- **Local-only.** No telemetry — data goes from disk to your MCP client and nowhere else. The only network calls fetch the pages you bookmarked (see [Page fetching](#page-fetching); `MNEMOS_FETCH_PAGES=0` stops them) and, once, the embedding runtime (from the npm registry) and model (from Hugging Face).
- **Zero state.** The file is re-read per call (Firefox's whenever it has changed), so results always reflect what's in your browser right now.
- **One file.** The whole server is [`src/index.ts`](src/index.ts) — auditable in five minutes.

## Development

```sh
git clone git@github.com:noesis-sol/mnemos.git && cd mnemos
npm install          # installs deps and builds via the prepare script
npm test             # unit + fixture + protocol tests (node:test, zero extra deps)
npm run build        # recompile after changes
node dist/index.js   # run the server (speaks MCP over stdio)
```

Tests run against a synthetic bookmarks fixture in [`test/fixtures/`](test/fixtures/)
— they never read your real Chrome profile. (Fixtures are injected via the same
`CHROME_BOOKMARKS_PATH` override users can set; new tests should do the same.)
CI runs the suite on macOS, Windows, and Linux across Node 22 and 24.

---

<div align="center">
<sub>Built with the <a href="https://github.com/modelcontextprotocol/typescript-sdk">official MCP TypeScript SDK</a>. Works with Chrome, Edge, Brave, Vivaldi, Chromium and Firefox on macOS, Windows, and Linux, and with Safari on macOS.</sub>
<br>
<sub>MIT © Michail Michailidis</sub>
</div>
