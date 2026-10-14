# Changelog

## 0.4.0 (unreleased)

### Changed

- An empty query (`search_bookmarks`, `semantic_search`) or an empty folder name (`list_folder_contents`) is now an error result (`isError: true`, the message as its text) instead of a normal result carrying `{ "error": … }`, so the assistant cannot read it as data. The messages are unchanged. ([#4](https://github.com/noesis-sol/mnemos/issues/4))
