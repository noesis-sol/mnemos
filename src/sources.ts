/**
 * The bookmarks sources mnemos reads: the browser or browsers --browser (or
 * MNEMOS_BOOKMARKS_BROWSER) selects, each in its profile, as bookmarks files.
 *
 *   default   the system default browser (default-browser.ts), in the
 *             profile --profile names, else the one it last used
 *   <id>      that browser, the same way
 *   <a>,<b>   each listed browser, in its default profile
 *   all       every profile with bookmarks of every browser here, each
 *             browser's default profile first
 *
 * A Chromium profile's source is its Bookmarks file and, beside it, its
 * AccountBookmarks file (the bookmarks saved to the Google account), read
 * together; see accountBookmarksFile(). MNEMOS_BOOKMARKS_PATH (or
 * CHROME_BOOKMARKS_PATH) names the one file to read instead. Every tool result reports the sources it read; with several, a
 * source that cannot be found or read is a warning, not an error, and each
 * source's folder paths start with its browser's name, then its profile's
 * when that browser has several sources ("Chrome › Work › Bookmarks Bar").
 */

import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_BOOKMARKS,
  BROWSER_NAMES,
  bookmarksPathOverride,
  browsersWithBookmarks,
  chromiumBase,
  chromiumBookmarksPath,
  chromiumLocalState,
  chromiumProfiles,
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
  /**
   * The bookmarks file. A Chromium profile's Bookmarks file, which keys the
   * profile's index, is named even when the profile keeps only account bookmarks.
   */
  bookmarks: string;
  /** A Chromium profile's AccountBookmarks file, when it has one: see accountBookmarksFile(). */
  account_bookmarks?: string;
}

/**
 * Where a Chromium profile's source keeps the bookmarks saved to the
 * signed-in account, whether or not the file exists yet: AccountBookmarks
 * beside its Bookmarks file. Undefined for other browsers and for a file
 * named by MNEMOS_BOOKMARKS_PATH (no profile), which is the one file read.
 */
export function accountBookmarksFile(source: Source): string | undefined {
  if (!source.browser || !isChromium(source.browser) || source.profile === null) return undefined;
  return path.join(path.dirname(source.bookmarks), ACCOUNT_BOOKMARKS);
}

/** A selected browser whose bookmarks file could not be found. */
export interface SourceFailure {
  browser: Browser;
  error: Error;
}

export interface Selection {
  sources: Source[];
  /**
   * Each source's folder path prefix, by index: "" for one browser, else its
   * browser's name and, when it has several sources, its profile's
   * ("Chrome › Work › "). See sourcePrefixes().
   */
  prefixes: string[];
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
    return { sources: [{ browser, profile: null, bookmarks: override }], prefixes: [""], failures: [], warnings: [], multi };
  }

  if (selection === "default") {
    const found = (select.detect ?? defaultBrowser)();
    return {
      sources: [browserSource(found.browser, profile, platform, env)],
      prefixes: [""],
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
  const sources: ProfileSource[] = [];
  const failures: SourceFailure[] = [];
  for (const browser of browsers) {
    try {
      if (selection === "all") sources.push(...profileSources(browser, platform, env));
      else sources.push({ source: browserSource(browser, multi ? undefined : profile, platform, env) });
    } catch (e) {
      if (!multi) throw e;
      failures.push({ browser, error: e instanceof Error ? e : new Error(String(e)) });
    }
  }
  return {
    sources: sources.map((s) => s.source),
    prefixes: multi ? sourcePrefixes(sources) : sources.map(() => ""),
    failures,
    warnings: [],
    multi,
  };
}

/**
 * The folder path prefix results give `source`'s folders in the selection now
 * ("Chrome › Work › "): "" with one browser, or when `source` is no longer
 * selected. It changes with the selection: a browser's profile is named only
 * while several of its profiles are read.
 */
export function sourcePrefix(source: Pick<Source, "bookmarks">, select?: SelectOptions): string {
  const selection = selectSources(select);
  const at = selection.sources.findIndex((s) => path.resolve(s.bookmarks) === path.resolve(source.bookmarks));
  return at < 0 ? "" : selection.prefixes[at];
}

/** A source, and the name its profile goes by in folder paths: the display name, else the directory's. */
export interface ProfileSource {
  source: Source;
  name?: string;
}

/**
 * Every profile of `browser` that has a bookmarks file, its default profile
 * (the one it last used, or opens) first, the rest in the order the browser
 * lists them. Throws when the browser has no bookmarks here.
 */
export function profileSources(
  browser: Browser,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProfileSource[] {
  if (browser === "safari") return [{ source: browserSource(browser, undefined, platform, env) }];
  let found: ProfileSource[];
  let first: string;
  if (isFirefox(browser)) {
    const profiles = firefoxProfiles(firefoxBase(browser, platform, env));
    first = path.join((profiles.find((p) => p.isDefault) ?? profiles[0])?.dir ?? "", "places.sqlite");
    found = profiles
      .filter((p) => fs.existsSync(path.join(p.dir, "places.sqlite")))
      .map((p) => ({
        source: { browser, profile: profileLabel(p.name, path.basename(p.dir)), bookmarks: path.join(p.dir, "places.sqlite") },
        name: p.name,
      }));
  } else if (isChromium(browser)) {
    const base = chromiumBase(browser, platform, env);
    const { names } = chromiumLocalState(base);
    first = chromiumBookmarksPath(browser, undefined, platform, env);
    found = chromiumProfiles(browser, platform, env).map((dir) => ({
      source: browserSource(browser, dir, platform, env),
      name: names[dir] ?? dir,
    }));
  } else {
    throw new Error(`no reader for ${browser}`);
  }
  // The browser's own error: no profiles.ini, or no profile with bookmarks.
  if (found.length === 0) return [{ source: browserSource(browser, undefined, platform, env) }];
  const at = found.findIndex((p) => path.resolve(p.source.bookmarks) === path.resolve(first));
  if (at > 0) found.unshift(...found.splice(at, 1));
  return found;
}

/**
 * The folder path prefix of each of several browsers' sources: the browser's
 * name, then, for a browser with several sources, the profile's name, or its
 * full label when another profile of that browser has the same name.
 */
function sourcePrefixes(sources: ProfileSource[]): string[] {
  const count = (pick: (s: ProfileSource) => unknown, of: ProfileSource) =>
    sources.filter((s) => s.source.browser === of.source.browser && pick(s) === pick(of)).length;
  return sources.map((s) => {
    const segments = [sourceName(s.source)];
    if (count(() => true, s) > 1) {
      const name = s.name ?? s.source.profile ?? "";
      segments.push(count((o) => o.name ?? o.source.profile, s) > 1 ? (s.source.profile ?? name) : name);
    }
    return segments.map((segment) => `${segment}${SEP}`).join("");
  });
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
  const source: Source = { browser, profile: profileLabel(chromiumLocalState(base).names[dir], dir), bookmarks };
  const account = accountBookmarksFile(source);
  if (account && fs.existsSync(account)) source.account_bookmarks = account;
  return source;
}

/** Path segments are joined with this — "/" can appear in folder names. */
export const SEP = " › ";

/** How results and warnings name a source: "Firefox", or "the bookmarks file" for one named by path. */
export function sourceName(source: Pick<Source, "browser">): string {
  return source.browser ? BROWSER_NAMES[source.browser] : "The bookmarks file";
}
