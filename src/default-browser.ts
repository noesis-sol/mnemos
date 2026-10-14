/**
 * The system's default web browser, as a mnemos browser id. Each OS names it
 * its own way: macOS by the app's bundle id (asked of LaunchServices, else read
 * from its preferences), Windows by the ProgId of the https URL association,
 * Linux by a .desktop file name (from xdg-settings, else mimeapps.list). The
 * tables below map those names to browser ids.
 *
 * When detection finds nothing, the first browser with bookmarks is read and a
 * warning says so. When it finds a browser mnemos cannot read (Arc, Orion, or
 * one it does not know), that is an error naming the browser: reading another
 * one instead would pass its bookmarks off as the user's current ones.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_ENV,
  BROWSER_NAMES,
  BROWSERS,
  browsersWithBookmarks,
  PATH_ENV,
  readIni,
  type Browser,
} from "./browsers.js";
import { parseBinaryPlist } from "./plist.js";

/** What detection runs on; each part can be replaced in tests. */
export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The home directory (default os.homedir()). */
  home?: string;
  /** Runs a command and returns its standard output; throws when it cannot run or fails. */
  run?: (command: string, args: string[]) => string;
  /** The browsers with bookmarks on this machine, in BROWSERS order. */
  installed?: () => Browser[];
}

/** The default browser's name as the OS gave it, and where it came from. */
export interface DetectedId {
  /** A bundle id (macOS), ProgId (Windows) or .desktop file name (Linux). */
  id: string;
  /** How it was found, for messages: "LaunchServices", "xdg-settings", … */
  source: string;
}

/** What `id` names: a browser mnemos reads, one it knows but cannot read (by name), or neither. */
export type Identified = { browser: Browser } | { unsupported: string } | { unknown: string };

export interface DefaultBrowser {
  browser: Browser;
  /** The OS's name for the default browser, when detection found it. */
  detected?: DetectedId;
  /** Set when detection failed and `browser` is the first one with bookmarks. */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Mapping tables. Keys are lower case: macOS's LaunchServices preferences store
// bundle ids in lower case, and Windows ProgIds are case-insensitive.
// ---------------------------------------------------------------------------

/** macOS bundle ids of the browsers mnemos reads. */
export const MAC_BUNDLE_IDS: Record<string, Browser> = {
  "com.google.chrome": "chrome",
  "com.google.chrome.beta": "chrome-beta",
  "com.google.chrome.dev": "chrome-dev",
  "com.google.chrome.canary": "chrome-canary",
  "org.chromium.chromium": "chromium",
  "com.microsoft.edgemac": "edge",
  "com.brave.browser": "brave",
  "com.vivaldi.vivaldi": "vivaldi",
  "com.operasoftware.opera": "opera",
  "org.mozilla.firefox": "firefox",
  "com.apple.safari": "safari",
};

/** macOS bundle ids of browsers mnemos knows but cannot read, by name. */
export const MAC_UNSUPPORTED: Record<string, string> = {
  "company.thebrowser.browser": "Arc",
  "company.thebrowser.dia": "Dia",
  "com.kagi.kagimacos": "Orion",
  "app.zen-browser.zen": "Zen",
  "org.mozilla.firefoxdeveloperedition": "Firefox Developer Edition",
  "org.mozilla.nightly": "Firefox Nightly",
  "org.torproject.torbrowser": "Tor Browser",
  "io.gitlab.librewolf-community": "LibreWolf",
  "net.waterfox.waterfox": "Waterfox",
  "one.ablaze.floorp": "Floorp",
  "com.duckduckgo.macos.browser": "DuckDuckGo",
  "com.microsoft.edgemac.beta": "Edge Beta",
  "com.microsoft.edgemac.dev": "Edge Dev",
  "com.microsoft.edgemac.canary": "Edge Canary",
  "com.brave.browser.beta": "Brave Beta",
  "com.brave.browser.nightly": "Brave Nightly",
  "com.operasoftware.operagx": "Opera GX",
  "com.apple.safaritechnologypreview": "Safari Technology Preview",
};

/**
 * Windows ProgIds of the browsers mnemos reads. Some installs add a suffix
 * after a dot or dash (FirefoxURL-308046B0AF4A39CB, VivaldiHTM.KJD3…), which
 * the lookup ignores.
 */
export const WINDOWS_PROGIDS: Record<string, Browser> = {
  chromehtml: "chrome",
  chromebhtml: "chrome-beta",
  chromedhtml: "chrome-dev",
  chromesshtm: "chrome-canary",
  chromiumhtm: "chromium",
  msedgehtm: "edge",
  bravehtml: "brave",
  vivaldihtm: "vivaldi",
  operastable: "opera",
  firefoxurl: "firefox",
  firefoxhtml: "firefox",
};

/** Windows ProgIds of browsers mnemos knows but cannot read, by name. */
export const WINDOWS_UNSUPPORTED: Record<string, string> = {
  msedgebhtml: "Edge Beta",
  msedgedhtml: "Edge Dev",
  msedgeshtml: "Edge Canary",
  bravebhtml: "Brave Beta",
  bravesshtm: "Brave Nightly",
  "opera gxstable": "Opera GX",
  operabeta: "Opera Beta",
  operadeveloper: "Opera Developer",
  waterfoxurl: "Waterfox",
  "ie.https": "Internet Explorer",
  appxq0fevzme2pys62n3e0fbqa7peapykr8v: "Edge Legacy",
};

/** Linux .desktop file names (without ".desktop") of the browsers mnemos reads: packages, Snaps, Flatpaks. */
export const LINUX_DESKTOP_FILES: Record<string, Browser> = {
  "google-chrome": "chrome",
  "com.google.chrome": "chrome",
  "google-chrome-beta": "chrome-beta",
  "google-chrome-unstable": "chrome-dev",
  "com.google.chromedev": "chrome-dev",
  "google-chrome-canary": "chrome-canary",
  chromium: "chromium",
  "chromium-browser": "chromium",
  chromium_chromium: "chromium",
  "org.chromium.chromium": "chromium",
  "microsoft-edge": "edge",
  "com.microsoft.edge": "edge",
  "brave-browser": "brave",
  brave_brave: "brave",
  "com.brave.browser": "brave",
  "vivaldi-stable": "vivaldi",
  "com.vivaldi.vivaldi": "vivaldi",
  opera: "opera",
  opera_opera: "opera",
  "com.opera.opera": "opera",
  firefox: "firefox",
  "firefox-esr": "firefox",
  firefox_firefox: "firefox",
  "org.mozilla.firefox": "firefox",
};

/** Linux .desktop file names of browsers mnemos knows but cannot read, by name. */
export const LINUX_UNSUPPORTED: Record<string, string> = {
  "microsoft-edge-beta": "Edge Beta",
  "microsoft-edge-dev": "Edge Dev",
  "brave-browser-beta": "Brave Beta",
  "brave-browser-nightly": "Brave Nightly",
  "vivaldi-snapshot": "Vivaldi Snapshot",
  librewolf: "LibreWolf",
  "io.gitlab.librewolf-community": "LibreWolf",
  waterfox: "Waterfox",
  "net.waterfox.waterfox": "Waterfox",
  "app.zen_browser.zen": "Zen",
  "one.ablaze.floorp": "Floorp",
  torbrowser: "Tor Browser",
  "org.torproject.torbrowser-launcher": "Tor Browser",
  "org.gnome.epiphany": "GNOME Web",
  "org.kde.falkon": "Falkon",
  "org.qutebrowser.qutebrowser": "qutebrowser",
};

/** What the OS's name for the default browser names. */
export function identifyBrowser(platform: NodeJS.Platform, id: string): Identified {
  const key = id.trim().toLowerCase();
  let supported: Browser | undefined;
  let unsupported: string | undefined;
  if (platform === "darwin") {
    supported = MAC_BUNDLE_IDS[key];
    unsupported = MAC_UNSUPPORTED[key];
  } else if (platform === "win32") {
    // ChromiumHTM.ABC → chromiumhtm; FirefoxURL-308046B0AF4A39CB → firefoxurl.
    const lookup = <T>(table: Record<string, T>): T | undefined => {
      const prefix = Object.keys(table).find(
        (k) => key === k || key.startsWith(`${k}.`) || key.startsWith(`${k}-`),
      );
      return prefix === undefined ? undefined : table[prefix];
    };
    supported = lookup(WINDOWS_PROGIDS);
    unsupported = lookup(WINDOWS_UNSUPPORTED);
  } else {
    const name = key.replace(/\.desktop$/, "");
    supported = LINUX_DESKTOP_FILES[name];
    unsupported = LINUX_UNSUPPORTED[name];
  }
  if (supported) return { browser: supported };
  if (unsupported) return { unsupported };
  return { unknown: id.trim() };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function runCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

/** Asks LaunchServices for the bundle id of the app that opens https: URLs. */
const MAC_SCRIPT =
  'ObjC.import("AppKit");' +
  'var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));' +
  'u.isNil() ? "" : ObjC.unwrap($.NSBundle.bundleWithURL(u).bundleIdentifier)';

const WINDOWS_ASSOCIATIONS = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https";

/**
 * The OS's name for its default browser, or why it could not be found. Never
 * throws: a command that is missing or fails moves on to the next source.
 */
export function detectDefaultBrowserId(options: DetectOptions = {}): DetectedId | { failure: string } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const run = options.run ?? runCommand;
  const tryRun = (command: string, args: string[]): string | undefined => {
    try {
      return run(command, args);
    } catch {
      return undefined;
    }
  };

  if (platform === "darwin") {
    const id = tryRun("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT])?.trim();
    if (id) return { id, source: "LaunchServices" };
    return macPreferencesHandler(home);
  }

  if (platform === "win32") {
    // Windows 11 24H2 and later keep the user's choice in UserChoiceLatest,
    // its ProgId value in a ProgId subkey (some builds put it on the key
    // itself), and may leave a stale one in UserChoice; older Windows, and apps
    // that set the default the old way, use UserChoice alone.
    for (const key of ["UserChoiceLatest", "UserChoiceLatest\\ProgId", "UserChoice"]) {
      const out = tryRun("reg", ["query", `${WINDOWS_ASSOCIATIONS}\\${key}`, "/v", "ProgId"]);
      const progId = out && /^\s*ProgId\s+REG_SZ\s+(.*\S)\s*$/im.exec(out)?.[1];
      if (progId) return { id: progId, source: `registry (${key})` };
    }
    return { failure: "the registry has no https UserChoice ProgId" };
  }

  // Linux and other unixes.
  const desktop = tryRun("xdg-settings", ["get", "default-web-browser"])?.split(/\r?\n/)[0].trim();
  if (desktop) return { id: desktop, source: "xdg-settings" };
  const fromList = mimeappsHandler(env, home);
  if (fromList) return fromList;
  return { failure: "xdg-settings gave no answer and no mimeapps.list sets x-scheme-handler/https" };
}

/**
 * The https handler in LaunchServices' preferences: the LSHandlers entry
 * whose LSHandlerURLScheme is https. Without one (or without the file), the
 * user never changed the default, which is Safari.
 */
function macPreferencesHandler(home: string): DetectedId | { failure: string } {
  const file = path.join(
    home,
    "Library",
    "Preferences",
    "com.apple.LaunchServices",
    "com.apple.launchservices.secure.plist",
  );
  const source = "LaunchServices preferences";
  let plist: unknown;
  try {
    plist = parseBinaryPlist(fs.readFileSync(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { id: "com.apple.Safari", source };
    return { failure: `cannot read ${file} (${(e as Error).message})` };
  }
  const handlers = isRecord(plist) && Array.isArray(plist.LSHandlers) ? plist.LSHandlers : [];
  for (const entry of handlers) {
    if (
      isRecord(entry) &&
      typeof entry.LSHandlerURLScheme === "string" &&
      entry.LSHandlerURLScheme.toLowerCase() === "https" &&
      typeof entry.LSHandlerRoleAll === "string" &&
      entry.LSHandlerRoleAll
    ) {
      return { id: entry.LSHandlerRoleAll, source };
    }
  }
  return { id: "com.apple.Safari", source };
}

/**
 * x-scheme-handler/https from the first mimeapps.list that sets it, in the
 * XDG MIME applications spec's order: the user's config directory, the
 * system's config directories, then the same below the data directories;
 * each desktop's own file ($desktop-mimeapps.list) before the shared one.
 */
function mimeappsHandler(env: NodeJS.ProcessEnv, home: string): DetectedId | undefined {
  const absolute = (value: string | undefined) => (value && path.isAbsolute(value) ? value : undefined);
  const dirList = (value: string | undefined, fallback: string[]) => {
    // ":" on Linux; path.delimiter so tests driving this on Windows split their own paths.
    const dirs = (value ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d));
    return dirs.length > 0 ? dirs : fallback;
  };
  const configHome = absolute(env.XDG_CONFIG_HOME) ?? path.join(home, ".config");
  const dataHome = absolute(env.XDG_DATA_HOME) ?? path.join(home, ".local", "share");
  const dirs = [
    configHome,
    ...dirList(env.XDG_CONFIG_DIRS, ["/etc/xdg"]),
    path.join(dataHome, "applications"),
    ...dirList(env.XDG_DATA_DIRS, ["/usr/local/share", "/usr/share"]).map((d) => path.join(d, "applications")),
  ];
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "")
    .split(":")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const names = [...desktops.map((d) => `${d}-mimeapps.list`), "mimeapps.list"];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      const section = readIni(file).find((s) => s.name === "Default Applications");
      const value = section?.keys["x-scheme-handler/https"];
      const id = value
        ?.split(";")
        .map((v) => v.trim())
        .find(Boolean);
      if (id) return { id, source: file };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const CHOOSE = `Choose a browser with --browser <id> or ${BROWSER_ENV} (one of: ${BROWSERS.join(", ")}).`;

/**
 * The default browser as a browser mnemos reads. Detection failing falls back
 * to the first browser with bookmarks, with a warning; a default browser
 * mnemos cannot read throws an error naming it.
 */
export function resolveDefaultBrowser(options: DetectOptions = {}): DefaultBrowser {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const installed = options.installed ?? (() => browsersWithBookmarks(undefined, platform, env));
  const detected = detectDefaultBrowserId(options);

  if ("failure" in detected) {
    const browser = installed()[0];
    if (!browser) {
      throw new Error(
        `Could not detect the system default browser (${detected.failure}), and no supported ` +
          `browser has bookmarks here. ${CHOOSE} Or set ${PATH_ENV} to a bookmarks file.`,
      );
    }
    return {
      browser,
      warning:
        `Could not detect the system default browser (${detected.failure}); reading ` +
        `${BROWSER_NAMES[browser]}, the first browser with bookmarks here. ${CHOOSE}`,
    };
  }

  const identified = identifyBrowser(platform, detected.id);
  if ("browser" in identified) return { browser: identified.browser, detected };

  // Never another browser instead: its bookmarks would pass for the current one's.
  const others = installed();
  throw new Error(
    ("unsupported" in identified
      ? `The system default browser is ${identified.unsupported} (${detected.id}, from ${detected.source}), whose bookmarks mnemos cannot read.`
      : `The system default browser is "${identified.unknown}" (from ${detected.source}), which mnemos does not know how to read.`) +
      ` ${CHOOSE}` +
      (others.length > 0 ? ` Browsers with bookmarks here: ${others.join(", ")}.` : ""),
  );
}

let cached: { value: DefaultBrowser } | { error: unknown } | undefined;

/**
 * resolveDefaultBrowser(), run on the first call and remembered for the life
 * of the process, its error included: the default browser rarely changes while
 * mnemos runs, and detection spawns a process.
 */
export function defaultBrowser(options: DetectOptions = {}): DefaultBrowser {
  if (!cached) {
    try {
      cached = { value: resolveDefaultBrowser(options) };
    } catch (error) {
      cached = { error };
    }
  }
  if ("error" in cached) throw cached.error;
  return cached.value;
}

/** Forget the remembered default browser (for tests). */
export function resetDefaultBrowser(): void {
  cached = undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
