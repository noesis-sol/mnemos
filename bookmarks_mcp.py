"""MCP server exposing the user's Chrome bookmarks (read-only).

The user's bookmarks are a curated signal of what they consider important,
trustworthy, and worth endorsing. This server lets an AI assistant consult
that signal: which topics the user cares about, which sources they approve
of, and what they have been saving recently.

Environment variables:
  CHROME_PROFILE        Chrome profile directory name (default: "Default")
  CHROME_BOOKMARKS_PATH Absolute path to a Bookmarks file (overrides the above)
"""

import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP

CHROME_BASE = os.path.expanduser("~/Library/Application Support/Google/Chrome")

mcp = FastMCP(
    "chrome-bookmarks",
    instructions=(
        "Read-only access to the user's Chrome bookmarks. Bookmarks are things "
        "the user deliberately saved: treat them as a map of what the user "
        "considers important and which sources/opinions they endorse. Folder "
        "names indicate topics of interest. Use search_bookmarks to check "
        "whether the user has saved material on a topic, list_folders to see "
        "their interest areas, top_domains to see which sources they trust, "
        "and recent_bookmarks to see what they are currently focused on."
    ),
)


def _bookmarks_path() -> str:
    override = os.environ.get("CHROME_BOOKMARKS_PATH")
    if override:
        return override
    profile = os.environ.get("CHROME_PROFILE", "Default")
    return os.path.join(CHROME_BASE, profile, "Bookmarks")


def _load_roots() -> dict:
    path = _bookmarks_path()
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("roots", {})
    except FileNotFoundError:
        available = []
        if os.path.isdir(CHROME_BASE):
            available = sorted(
                p for p in os.listdir(CHROME_BASE)
                if os.path.isfile(os.path.join(CHROME_BASE, p, "Bookmarks"))
            )
        raise RuntimeError(
            f"No bookmarks file at {path}. "
            f"Chrome profiles that have bookmarks: {', '.join(available) or 'none'}. "
            "Set CHROME_PROFILE (profile directory name) or CHROME_BOOKMARKS_PATH."
        ) from None
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Bookmarks file at {path} is not valid JSON ({e}). "
            "Chrome may be mid-write; retry in a moment."
        ) from None


def _chrome_time_to_iso(value: str | int | None) -> str | None:
    # Chrome timestamps are microseconds since 1601-01-01 UTC. Imported or
    # corrupted bookmarks can carry out-of-range values — never let one bad
    # timestamp fail a whole tool call.
    try:
        micros = int(value)
        if micros <= 0:
            return None
        unix = micros / 1_000_000 - 11_644_473_600
        return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _walk(node: dict, path: str):
    """Yield (folder_path, bookmark_node) for every url node under `node`."""
    for child in node.get("children", []):
        if child.get("type") == "url":
            yield path, child
        elif child.get("type") == "folder":
            yield from _walk(child, f"{path}/{child.get('name', '')}")


def _all_bookmarks():
    root_labels = {"bookmark_bar": "Bookmarks Bar", "other": "Other Bookmarks", "synced": "Mobile Bookmarks"}
    for key, root in _load_roots().items():
        if isinstance(root, dict):
            yield from _walk(root, root_labels.get(key, key))


def _folder_matches(fpath: str, needle: str) -> bool:
    """True if `needle` matches a folder name in the path at a word boundary.

    Matching per path segment (not the joined path) prevents false positives
    like "ai" matching "Painting".
    """
    needle = needle.strip().lower()
    if not needle:
        return True
    pattern = re.compile(rf"\b{re.escape(needle)}\b")
    return any(pattern.search(segment.lower()) for segment in fpath.split("/"))


def _fmt(folder: str, node: dict) -> dict:
    return {
        "title": node.get("name", ""),
        "url": node.get("url", ""),
        "folder": folder,
        "added": _chrome_time_to_iso(node.get("date_added")),
    }


@mcp.tool()
def search_bookmarks(query: str, folder: str = "", limit: int = 100) -> str:
    """Search the user's bookmarks by title, URL, and folder path.

    Use this to check whether the user has saved material about a topic —
    a hit means the user found that page important or agreeable. All words
    in `query` must appear in the title, URL, or folder path (case-
    insensitive). Note: because the folder path is searched too, a topic
    word matches everything filed under a folder of that name. Optionally
    restrict to folders whose name matches `folder` (word-boundary match).
    Returns JSON with `total_matches`; if it exceeds `limit`, the list is
    truncated — do not assume the returned items are all there is.
    """
    words = query.lower().split()
    if not words:
        return json.dumps({
            "error": "Empty query. Provide one or more search words, or use "
                     "list_folders / recent_bookmarks to browse instead."
        })
    matches = []
    for fpath, node in _all_bookmarks():
        if folder and not _folder_matches(fpath, folder):
            continue
        haystack = f"{node.get('name', '')} {node.get('url', '')} {fpath}".lower()
        if all(w in haystack for w in words):
            matches.append(_fmt(fpath, node))
    cap = max(1, min(limit, 200))
    if not matches:
        return json.dumps({"total_matches": 0, "matches": [], "note": f"No bookmarks match {query!r}."})
    return json.dumps(
        {"total_matches": len(matches), "matches": matches[:cap]}, ensure_ascii=False
    )


@mcp.tool()
def list_folders() -> str:
    """List the user's bookmark folder tree with bookmark counts.

    Folder names are the user's own taxonomy of what matters to them —
    use this to get an overview of their interest areas before searching.
    """
    counts: dict[str, int] = {}
    for fpath, _node in _all_bookmarks():
        counts[fpath] = counts.get(fpath, 0) + 1
    tree = [{"folder": path, "bookmarks": n} for path, n in sorted(counts.items())]
    return json.dumps({"folders": tree, "total_bookmarks": sum(counts.values())}, ensure_ascii=False)


@mcp.tool()
def list_folder_contents(folder: str, limit: int = 100) -> str:
    """List bookmarks in folders whose name matches `folder` (case-insensitive
    word-boundary match on folder names, subfolders included).

    Use after list_folders to read everything the user saved on a topic.
    Returns JSON with `total_matches`; if it exceeds `limit`, the list is
    truncated — do not assume the returned items are all there is.
    """
    if not folder.strip():
        return json.dumps({"error": "Empty folder name. Call list_folders to see available folders."})
    matches = []
    for fpath, node in _all_bookmarks():
        if _folder_matches(fpath, folder):
            matches.append(_fmt(fpath, node))
    cap = max(1, min(limit, 200))
    if not matches:
        return json.dumps({"total_matches": 0, "bookmarks": [], "note": f"No folder matches {folder!r}."})
    return json.dumps(
        {"total_matches": len(matches), "bookmarks": matches[:cap]}, ensure_ascii=False
    )


@mcp.tool()
def recent_bookmarks(limit: int = 100) -> str:
    """Return the most recently added bookmarks, newest first.

    Use this to see what the user is currently interested in or researching.
    """
    items = []
    for fpath, node in _all_bookmarks():
        try:
            added = int(node.get("date_added", 0))
        except (TypeError, ValueError):
            added = 0
        items.append((added, fpath, node))
    items.sort(key=lambda t: t[0], reverse=True)
    results = [_fmt(fpath, node) for _added, fpath, node in items[: max(1, min(limit, 200))]]
    return json.dumps({"bookmarks": results}, ensure_ascii=False)


@mcp.tool()
def top_domains(limit: int = 25) -> str:
    """Return the domains the user bookmarks most often, with counts.

    Frequently bookmarked domains are sources the user trusts and returns
    to — treat them as the user's approved sources.
    """
    counts: dict[str, int] = {}
    for _fpath, node in _all_bookmarks():
        host = urlparse(node.get("url", "")).netloc.removeprefix("www.")
        if host:
            counts[host] = counts.get(host, 0) + 1
    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[: max(1, min(limit, 100))]
    return json.dumps({"domains": [{"domain": d, "bookmarks": n} for d, n in top]})


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
