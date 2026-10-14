# Writes the LaunchServices preferences fixtures in this directory, binary
# plists shaped like macOS's
# ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist:
#   launchservices-brave.plist     https handled by Brave, beside other handlers
#   launchservices-no-https.plist  handlers, none of them for https (Safari's default)
# Regenerate with:
#   python3 test/fixtures/default-browser/make-launchservices.py
import pathlib
import plistlib

HERE = pathlib.Path(__file__).parent


def write(name, handlers):
    data = {"LSHandlers": handlers}
    (HERE / name).write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY, sort_keys=True))


OTHERS = [
    {"LSHandlerContentType": "public.html", "LSHandlerRoleAll": "com.google.chrome"},
    {"LSHandlerURLScheme": "mailto", "LSHandlerRoleAll": "com.apple.mail"},
    {"LSHandlerURLScheme": "http", "LSHandlerRoleAll": "com.google.chrome"},
]

write(
    "launchservices-brave.plist",
    OTHERS + [{"LSHandlerPreferredVersions": {"LSHandlerRoleAll": "-"}, "LSHandlerURLScheme": "https", "LSHandlerRoleAll": "com.brave.browser"}],
)
write("launchservices-no-https.plist", OTHERS)
