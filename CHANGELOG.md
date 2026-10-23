# Changelog

## Unreleased

### Fixed

- The semantic index follows bookmarks you add, rename, move or delete within about a minute, without waiting for a `semantic_search` call. Before, it was re-synced only at startup and by `semantic_search`, so a new bookmark's page was not fetched until one of them came.

## 0.5.0 (2026-10-14)

Semantic search over your bookmarks and the pages they point to, and bookmarks from every major browser. Several changes are breaking — see *Upgrading from 0.3* in the README. To stay on 0.3, use `mnemos-mcp@0.3` in your MCP configuration.

### Breaking

- **Node 22.13 or later** is required (Node 18 and 20 are no longer supported): mnemos's index uses `node:sqlite`. On an older Node, mnemos still connects to the MCP client and answers every tool with what to do — upgrade Node, or pin `mnemos-mcp@0.3` — so the assistant can relay it instead of the client showing only "failed to connect".
- mnemos now reads the system default browser's bookmarks by default (in the profile it last used), not Chrome's. `--browser` / `MNEMOS_BOOKMARKS_BROWSER` take `default`, a browser id, a comma-separated list (`chrome,firefox`) or `all` (every browser with bookmarks here), each listed browser in its default profile. To keep reading Chrome, add `--browser chrome`; a configuration that sets `CHROME_PROFILE` or `CHROME_BOOKMARKS_PATH` and no browser still reads Chrome. An unknown browser in `MNEMOS_BOOKMARKS_BROWSER`, or `--profile` / `MNEMOS_PROFILE` / a bookmarks path with several browsers, now stops mnemos at startup with a message listing the valid ids. ([#11](https://github.com/noesis-sol/mnemos/issues/11))
- **mnemos now uses the network and writes to disk** (0.3 did neither), for semantic search. After the MCP handshake it installs its embedding runtime (about 490 MB, once) and downloads the embedding model (about 135 MB, from Hugging Face) into its cache directory (`~/Library/Caches/mnemos`, `%LOCALAPPDATA%\mnemos\Cache` or `~/.cache/mnemos`; `MNEMOS_CACHE_DIR` moves it), keeps its index there, and fetches the pages you bookmarked in the background. `MNEMOS_FETCH_PAGES=0` turns page fetching off and `MNEMOS_INSTALL_RUNTIME=0` the runtime install (`semantic_search` then matches keywords only). See the README's *Page fetching* and *Privacy & design*.
- An empty query (`search_bookmarks`, `semantic_search`) or an empty folder name (`list_folder_contents`) is now an error result (`isError: true`, the message as its text) instead of a normal result carrying `{ "error": … }`, so the assistant cannot read it as data. The messages are unchanged. ([#4](https://github.com/noesis-sol/mnemos/issues/4))

### Changed

- `recent_bookmarks` adds a `note` when some or all of the bookmarks it returns have no date added, as with Safari, which stores a date only for Reading List items: those bookmarks are in the file's order, not newest first, so the list no longer passes Favorites off as what the user added recently.
- Without `--profile` or `MNEMOS_PROFILE`, mnemos reads the profile the browser opens: for a Chromium-based browser the one it last used (`profile.last_used` in `Local State`, else `Default`), for Firefox the one `installs.ini` names for the install (else the `profiles.ini` default). `--profile` also takes a profile's display name (`--profile Work`), and the missing-profile error lists profiles as `Display Name (directory)`. ([#13](https://github.com/noesis-sol/mnemos/issues/13))

### Added

- `semantic_search(query, folder?, limit?)` finds bookmarks by meaning, not only by keyword, across languages: each bookmark's title, description, folder path and URL words, and the text of the page it points to, are embedded by multilingual-e5-small running locally. Exact keyword matches always rank first; results carry a `score`, what matched (`title` or `page`, with a snippet) and, while indexing is under way, a `status` saying how far it has got. Only new or changed bookmarks are embedded again, and until the index is ready `semantic_search` falls back to keyword matching.
- Pages are fetched politely and safely: https first, at most 4 at a time and one per site a second apart; never loopback, private or link-local addresses (`MNEMOS_FETCH_ALLOW_HOSTS` exempts hosts); never URLs carrying tokens or logout/unsubscribe actions; never `MNEMOS_SKIP_DOMAINS` or `MNEMOS_SKIP_FOLDERS`. Readable text comes from Mozilla's Readability, a PDF's from pdf.js, and a JavaScript-only page's from a headless Chrome, Edge, Chromium or Brave you already have (`MNEMOS_BROWSER`), in a temporary profile. Pages are fetched again after 30 days, failures retried with backoff, and deleted bookmarks leave the index. When several MCP clients run mnemos, one of them fetches.
- Bookmarks from Edge, Brave, Vivaldi, Chromium, Opera, Chrome Beta/Dev/Canary, Firefox and Safari (its Reading List included), on macOS, Windows and Linux (Snap and Flatpak included), chosen with `--browser` / `MNEMOS_BOOKMARKS_BROWSER`; `--profile` / `MNEMOS_PROFILE` picks the profile, and `MNEMOS_BOOKMARKS_PATH` reads any supported file, telling the formats apart by their first bytes.
- The system default browser is detected on macOS (LaunchServices), Windows (the https `UserChoice`/`UserChoiceLatest` ProgId) and Linux (`xdg-settings`, else `mimeapps.list`). ([#12](https://github.com/noesis-sol/mnemos/issues/12))
- Bookmarks carry a `description` where the browser stores one (Vivaldi, Firefox, Safari's Reading List), which `search_bookmarks` searches too.
- `--browser all` reads every profile with bookmarks of every browser here, each browser's default profile first; a browser read in several profiles has the profile's name in its folder paths (`Chrome › Work › Bookmarks Bar`), and a profile that cannot be read, like Safari without Full Disk Access, is a warning naming it. A page saved in several browsers or profiles counts once in `top_domains` and is one result in `semantic_search`. ([#9](https://github.com/noesis-sol/mnemos/issues/9))
- A bookmarks file is parsed again only when its modification time or size changes (Firefox's database already was); `MNEMOS_BOOKMARKS_PATH` naming a file in none of the supported formats now says so instead of suggesting a retry. ([#9](https://github.com/noesis-sol/mnemos/issues/9))
- With several browsers selected, their page fetchers share one set of limits: at most 4 fetches at a time and one per site, a second apart, over all of them, taking turns; a page bookmarked in several browsers is fetched once, the other indexes taking its text (if it was fetched within a day).
- With several browsers selected, their page fetchers render JavaScript-only pages in one shared headless browser, not one each, closed once none of them has a page left for it.
- `--browser librewolf`, `waterfox`, `zen`, `floorp` and `tor-browser` read the bookmarks of Firefox's forks (LibreWolf, Waterfox, Zen, Floorp, Tor Browser) from their own profile directories on macOS, Windows and Linux (Flatpak included), with the Firefox reader; detecting one as the system default browser now names it instead of calling it unreadable. ([#7](https://github.com/noesis-sol/mnemos/issues/7))
- On Windows, LibreWolf, Zen and Floorp are detected as the system default browser: LibreWolf by its `LibreWolfHTM` ProgId, Zen and Floorp, whose installers register Firefox's own `FirefoxURL-<hash>` ProgId, by the executable that ProgId opens (`zen.exe`, `floorp.exe`), so neither is read as Firefox; another fork registering Firefox's ProgId is named as unknown instead of read as Firefox.
- On Linux, LibreWolf, Zen and Floorp profiles are also found in the XDG directories their Firefox 147+ based releases use for new installs: `$XDG_CONFIG_HOME/librewolf/librewolf`, `$XDG_CONFIG_HOME/zen` and `$XDG_CONFIG_HOME/floorp` (else below `~/.config`), after the classic `~/.librewolf`, `~/.zen` and `~/.floorp`.
- Every tool result, `semantic_search`'s included, carries `sources` (`[{ browser, profile, bookmarks }]`, the files it read) and, when several browsers are read and some cannot be, `warnings` naming them; the rest are still searched. With several browsers, folder paths start with the browser's name, and `semantic_search` ranks the results of each bookmarks file's own index as one library. ([#11](https://github.com/noesis-sol/mnemos/issues/11))

### Fixed

- A `null` in a bookmark folder's children no longer fails the whole tool call; such entries are skipped. ([#2](https://github.com/noesis-sol/mnemos/issues/2))
- A bookmarks file that exists but cannot be read (permissions, a directory at that path) is reported by its error code, not as missing. ([#3](https://github.com/noesis-sol/mnemos/issues/3))
- A bookmarks file starting with a UTF-8 byte order mark is read, instead of being reported as Chrome writing it. ([#5](https://github.com/noesis-sol/mnemos/issues/5))
