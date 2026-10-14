/**
 * The bookmarks sources mnemos reads: the browser or browsers --browser (or
 * MNEMOS_BOOKMARKS_BROWSER) selects, each in its profile, as bookmarks files.
 *
 *   default   the system default browser (default-browser.ts), in the
 *             profile --profile names, else the one it last used
 *   <id>      that browser, the same way
 *   <a>,<b>   each listed browser, in its default profile
 *   all       every browser with bookmarks here, in its default profile
 *
 * MNEMOS_BOOKMARKS_PATH (or CHROME_BOOKMARKS_PATH) names the one file to read
 * instead. Every tool result reports the sources it read; with several, a
 * source that cannot be found or read is a warning, not an error.
 */

import path from "node:path";
import {
  BROWSER_NAMES,
  bookmarksPathOverride,
  browsersWithBookmarks,
  chromiumBase,
  chromiumBookmarksPath,
  chromiumLocalState,
  firefoxBase,
  firefoxPlacesPath,
  firefoxProfiles,
  isChromium,
  isFirefox,
  isMultiBrowser,
  profileLabel,
  safariBookmarksPath,
  selectedBrowsers,
  selectedProfile,
  type Browser,
  type StartupOptions,
} from "./browsers.js";
import { defaultBrowser, type DefaultBrowser } from "./default-browser.js";

/** One bookmarks file, as every tool result reports it. */
export interface Source {
  /** The browser; null for a file MNEMOS_BOOKMARKS_PATH names when no browser is chosen. */
  browser: Browser | null;
  /** "Display Name (directory)", or the directory; null for Safari, which has no profiles, and for a file named by path. */
  profile: string | null;
  /** The bookmarks file. */
  bookmarks: string;
}

/** A selected browser whose bookmarks file could not be found. */
export interface SourceFailure {
  browser: Browser;
  error: Error;
}

export interface Selection {
  sources: Source[];
  /** Browsers of a list (or of all) whose file could not be found; with one browser, that is thrown instead. */
  failures: SourceFailure[];
  /** Warnings for the result, such as the default browser's fallback when detection failed. */
  warnings: string[];
  /** More than one browser was asked for: results name each bookmark's browser in its folder path. */
  multi: boolean;
}

export interface SelectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The startup flags; defaults to those recorded at startup. */
  options?: StartupOptions;
  /** The system default browser; defaults to default-browser.ts's, detected once per process. */
  detect?: () => DefaultBrowser;
}

/** The selected sources: see the module comment. Throws when the one selected browser cannot be found. */
export function selectSources(select: SelectOptions = {}): Selection {
  const env = select.env ?? process.env;
  const platform = select.platform ?? process.platform;
  const selection = selectedBrowsers(env, select.options);
  const profile = selectedProfile(env, select.options);
  const multi = isMultiBrowser(selection);

  const override = bookmarksPathOverride(env);
  if (override) {
    if (multi) throw new Error("A bookmarks file set by MNEMOS_BOOKMARKS_PATH cannot be read with several browsers.");
    const browser = Array.isArray(selection) ? selection[0] : null;
    return { sources: [{ browser, profile: null, bookmarks: override }], failures: [], warnings: [], multi };
  }

  if (selection === "default") {
    const found = (select.detect ?? defaultBrowser)();
    return {
      sources: [browserSource(found.browser, profile, platform, env)],
      failures: [],
      warnings: found.warning ? [found.warning] : [],
      multi,
    };
  }

  const browsers = selection === "all" ? browsersWithBookmarks(undefined, platform, env) : selection;
  if (browsers.length === 0) {
    throw new Error(
      "No supported browser has bookmarks here (--browser all). Choose a browser with --browser <id>, " +
        "or set MNEMOS_BOOKMARKS_PATH to a bookmarks file.",
    );
  }
  const sources: Source[] = [];
  const failures: SourceFailure[] = [];
  for (const browser of browsers) {
    try {
      sources.push(browserSource(browser, multi ? undefined : profile, platform, env));
    } catch (e) {
      if (!multi) throw e;
      failures.push({ browser, error: e instanceof Error ? e : new Error(String(e)) });
    }
  }
  return { sources, failures, warnings: [], multi };
}

/** The bookmarks file of `browser` in `profile` (its default profile when unset), and the profile's label. */
export function browserSource(
  browser: Browser,
  profile: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Source {
  if (browser === "safari") return { browser, profile: null, bookmarks: safariBookmarksPath() };
  if (isFirefox(browser)) {
    const bookmarks = firefoxPlacesPath(browser, profile, platform, env);
    const dir = path.dirname(bookmarks);
    const found = firefoxProfiles(firefoxBase(browser, platform, env)).find(
      (p) => path.resolve(p.dir) === path.resolve(dir),
    );
    return { browser, profile: profileLabel(found?.name, path.basename(dir)), bookmarks };
  }
  if (!isChromium(browser)) throw new Error(`no reader for ${browser}`);
  const bookmarks = chromiumBookmarksPath(browser, profile, platform, env);
  const base = chromiumBase(browser, platform, env);
  // Opera's older root-level Bookmarks file is its Default profile.
  const dir = path.dirname(bookmarks) === base ? "Default" : path.basename(path.dirname(bookmarks));
  return { browser, profile: profileLabel(chromiumLocalState(base).names[dir], dir), bookmarks };
}

/** How results and warnings name a source: "Firefox", or "the bookmarks file" for one named by path. */
export function sourceName(source: Pick<Source, "browser">): string {
  return source.browser ? BROWSER_NAMES[source.browser] : "The bookmarks file";
}
