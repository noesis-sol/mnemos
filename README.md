<div align="center">

# 🧠 mnemos

**Search your bookmarks by meaning, from any AI assistant.**

[![npm](https://img.shields.io/npm/v/mnemos-mcp?logo=npm&color=CB3837)](https://www.npmjs.com/package/mnemos-mcp)
[![CI](https://github.com/noesis-sol/mnemos/actions/workflows/ci.yml/badge.svg)](https://github.com/noesis-sol/mnemos/actions/workflows/ci.yml)
[![Node 22.13+](https://img.shields.io/badge/node-22.13+-339933?logo=node.js&logoColor=white)](https://nodejs.org)

</div>

mnemos (from the Greek μνήμη, memory) is a local [MCP](https://modelcontextprotocol.io)
server that gives AI assistants your browser bookmarks: what you chose to keep,
the sources you trust, and what you are reading now.

**Its core is local embeddings.** mnemos embeds each bookmark's title, and the
text of the page it points to, with a multilingual embedding model
([multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small))
that runs on your machine. It keeps the vectors in a local SQLite index.
`semantic_search` then finds bookmarks by what they are about, whatever words
or language you use: *beginner jogging schedule* finds *Couch to 5K: a
week-by-week running plan*, and *best beaches in Crete* finds *Οι καλύτερες
παραλίες της Κρήτης*. No embedding API is called, and your bookmarks, the
pages' text and your queries never leave your machine.

## Install

Requires Node 22.13+ on macOS, Windows or Linux.

**Claude Code**

```sh
claude mcp add --scope user mnemos -- npx -y mnemos-mcp
```

**Claude Desktop**, in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "mnemos": { "command": "npx", "args": ["-y", "mnemos-mcp"] } } }
```

mnemos reads your default browser's bookmarks, and the keyword tools work
right away. Semantic search needs a one-time download: about 490 MB of
embedding runtime from npm and a 135 MB model from Hugging Face. mnemos then
embeds your titles, and fetches and embeds your pages in the background. Until
the index is ready, `semantic_search` returns keyword matches and its `status`
says how far indexing has got.

<img width="1774" height="887" alt="Bookmarks to Vector Store Pipeline" src="https://github.com/user-attachments/assets/9f4f2929-92e3-47d9-aaaa-f4d223310894" />


Then ask things like *"What have I been reading about lately?"* or *"Did I
save anything on keeping a sourdough starter alive?"*

Coming from 0.3? See [0.5.0 in the changelog](CHANGELOG.md#050-2026-10-14).

## Tools

| Tool | Returns |
|------|---------|
| `semantic_search(query, folder?, limit?)` | Bookmarks ranked by meaning over their titles and page text, in any language, with exact keyword matches first |
| `search_bookmarks(query, folder?, limit?)` | Bookmarks whose title, URL, folder or description contains every query word |
| `list_folders()` | Every folder, with bookmark counts |
| `list_folder_contents(folder, limit?)` | Everything in a folder and its subfolders |
| `recent_bookmarks(limit?)` | The newest bookmarks first |
| `top_domains(limit?)` | The sites you bookmark most |

## Browsers

Chrome, Edge, Brave, Vivaldi, Opera, Chromium, Firefox and its forks
(LibreWolf, Waterfox, Zen, Floorp, Tor Browser), and Safari on macOS.

| Flag | Environment variable | Default |
|------|----------------------|---------|
| `--browser <ids>` | `MNEMOS_BOOKMARKS_BROWSER` | `default`, your system's default browser |
| `--profile <name>` | `MNEMOS_PROFILE` | the profile the browser opens |

`--browser` takes `default`, `all`, or a comma-separated list of `chrome`,
`chrome-beta`, `chrome-dev`, `chrome-canary`, `chromium`, `edge`, `brave`,
`vivaldi`, `opera`, `firefox`, `librewolf`, `waterfox`, `zen`, `floorp`,
`tor-browser` and `safari`. For example:
`claude mcp add --scope user mnemos -- npx -y mnemos-mcp --browser firefox,safari`.

- `all` reads every profile of every browser, so your work and personal
  bookmarks reach your assistant together. Use `--browser` and `--profile` to
  keep them apart.
- Safari's bookmarks need Full Disk Access for the app that runs mnemos (your
  terminal, or Claude Desktop): System Settings › Privacy & Security.

## Configuration

Environment variables, set with `-e`, as in
`claude mcp add --scope user mnemos -e MNEMOS_FETCH_PAGES=0 -- npx -y mnemos-mcp`:

| Variable | Effect |
|----------|--------|
| `MNEMOS_FETCH_PAGES=0` | Don't fetch pages; semantic search uses titles only |
| `MNEMOS_SKIP_DOMAINS` | Domains, with their subdomains, whose pages are never fetched (comma-separated) |
| `MNEMOS_SKIP_FOLDERS` | Folders whose pages are never fetched; their titles stay searchable |
| `MNEMOS_FETCH_ALLOW_HOSTS` | Hosts on your own network that may be fetched anyway, e.g. an intranet wiki |
| `MNEMOS_BROWSER` | The Chrome, Edge, Chromium or Brave used for pages that need JavaScript; `0` turns it off |
| `MNEMOS_INSTALL_RUNTIME=0` | Don't install the embedding runtime; semantic search matches keywords only |
| `MNEMOS_CACHE_DIR` | Where the index, model and runtime live |
| `MNEMOS_BOOKMARKS_PATH` | A bookmarks file to read instead of a browser's |

## Privacy

- **Read-only.** mnemos never writes to your bookmarks.
- **Local.** The index, the pages' text, the vectors and your queries stay on
  your machine. There is no telemetry, and results go only to your MCP client.
- **Network.** mnemos fetches each bookmarked page from its own site, signed
  out, with no cookies. It never fetches addresses on your own network, URLs
  that carry tokens, or logout and unsubscribe links. It does not read
  `robots.txt`, since it opens only pages you saved, one at a time, and it
  takes a `403` or `429` as a refusal. A page that needs JavaScript loads in a
  headless copy of a browser you have, with a throwaway profile, so the hosts
  that page uses see the request. The full policy is in
  [`src/fetch.ts`](src/fetch.ts). The only other downloads are the runtime and
  the model, once each.
- **Disposable cache.** Everything mnemos builds is in `~/Library/Caches/mnemos`,
  `%LOCALAPPDATA%\mnemos\Cache` or `~/.cache/mnemos`. You can delete it at any
  time, and mnemos rebuilds it.

## Development

```sh
npm install            # installs and builds
npm test               # unit, fixture and protocol tests
scripts/check-full.sh  # plus the end-to-end suites, with the real model
```

Tests read fixtures, never your bookmarks. [`test/FEATURES.md`](test/FEATURES.md)
maps each feature to its tests. To release, commit the version bump and its
[CHANGELOG](CHANGELOG.md) entry, then push a `vX.Y.Z` tag:
[`release.yml`](.github/workflows/release.yml) runs every test on macOS,
Windows and Linux, then publishes to npm.

<sub>MIT © Michail Michailidis</sub>
