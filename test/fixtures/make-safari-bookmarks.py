# Writes test/fixtures/safari-bookmarks.plist, a small binary plist shaped like
# Safari's ~/Library/Safari/Bookmarks.plist, and safari-bookmarks-undated.plist,
# the same tree with no Reading List dates: like a real Safari, where only
# Reading List items carry a date added. Python's plistlib is an
# independent writer, so the fixture checks src/plist.ts against a real
# encoder rather than against itself. Regenerate with:
#   python3 test/fixtures/make-safari-bookmarks.py
import datetime
import pathlib
import plistlib


def leaf(title, url, **extra):
    return {
        "WebBookmarkType": "WebBookmarkTypeLeaf",
        "WebBookmarkUUID": f"uuid-{title}",
        "URLString": url,
        "URIDictionary": {"title": title},
        **extra,
    }


def folder(title, children, **extra):
    return {"WebBookmarkType": "WebBookmarkTypeList", "Title": title, "Children": children, **extra}


root = {
    "WebBookmarkFileVersion": 1,
    "WebBookmarkType": "WebBookmarkTypeList",
    "Title": "",
    "Sync": {"Key": b"\x00\x01\x02 binary data", "ServerVersion": 70000, "Big": 2**40, "Ratio": 0.5},
    "Children": [
        {"WebBookmarkType": "WebBookmarkTypeProxy", "Title": "History", "WebBookmarkIdentifier": "History"},
        folder(
            "BookmarksBar",
            [
                leaf("Apple", "https://www.apple.com/"),
                folder("Ελληνικά", [leaf("Βικιπαίδεια", "https://el.wikipedia.org/")]),
            ],
        ),
        folder("BookmarksMenu", [leaf("MDN Web Docs", "https://developer.mozilla.org/")]),
        folder("Recipes", [leaf("Sourdough", "https://bread.example/sourdough", ShouldOmitFromUI=False)]),
        folder(
            "com.apple.ReadingList",
            [
                leaf(
                    "Tidepools",
                    "https://example.org/tidepools",
                    ReadingList={
                        "DateAdded": datetime.datetime(2024, 5, 1, 12, 0, 0),
                        "PreviewText": "Why tidepools matter for coastal ecology.",
                    },
                ),
                leaf("Undated", "https://example.org/undated", ReadingList={}),
            ],
        ),
        leaf("Loose bookmark", "https://loose.example/"),
    ],
}

out = pathlib.Path(__file__).with_name("safari-bookmarks.plist")
out.write_bytes(plistlib.dumps(root, fmt=plistlib.FMT_BINARY))

for child in root["Children"]:
    if child.get("Title") == "com.apple.ReadingList":
        for item in child["Children"]:
            item["ReadingList"].pop("DateAdded", None)
out = pathlib.Path(__file__).with_name("safari-bookmarks-undated.plist")
out.write_bytes(plistlib.dumps(root, fmt=plistlib.FMT_BINARY))
