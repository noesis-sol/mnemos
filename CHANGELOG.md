# Changelog

## 0.4.0 (unreleased)

### Changed

- An empty query (`search_bookmarks`, `semantic_search`) or an empty folder name (`list_folder_contents`) is now an error result (`isError: true`, the message as its text) instead of a normal result carrying `{ "error": … }`, so the assistant cannot read it as data. The messages are unchanged. ([#4](https://github.com/noesis-sol/mnemos/issues/4))
- `recent_bookmarks` adds a `note` when some or all of the bookmarks it returns have no date added, as with Safari, which stores a date only for Reading List items: those bookmarks are in the file's order, not newest first, so the list no longer passes Favorites off as what the user added recently.
- Without `--profile` or `MNEMOS_PROFILE`, mnemos reads the profile the browser opens: for a Chromium-based browser the one it last used (`profile.last_used` in `Local State`, else `Default`), for Firefox the one `installs.ini` names for the install (else the `profiles.ini` default). `--profile` also takes a profile's display name (`--profile Work`), and the missing-profile error lists profiles as `Display Name (directory)`. ([#13](https://github.com/noesis-sol/mnemos/issues/13))

### Added

- `--browser librewolf`, `waterfox`, `zen`, `floorp` and `tor-browser` read the bookmarks of Firefox's forks (LibreWolf, Waterfox, Zen, Floorp, Tor Browser) from their own profile directories on macOS, Windows and Linux (Flatpak included), with the Firefox reader; detecting one as the system default browser now names it instead of calling it unreadable. ([#7](https://github.com/noesis-sol/mnemos/issues/7))
