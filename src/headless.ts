/**
 * Rendering JavaScript-only pages in a headless browser. A page whose plain
 * fetch has no readable text (a shell that builds itself with JavaScript)
 * is loaded once more in a Chromium-based browser already installed on the
 * machine, and its rendered HTML goes to the same extraction.
 *
 * playwright-core drives the browser. It is an optionalDependency loaded with
 * import() on first use and downloads no browser: mnemos uses one that is
 * installed (resolveBrowser), and with neither, pages that need a browser
 * stay needs_browser and the status says how to get one.
 *
 * The browser gets a fresh temporary profile (never the user's), deleted on
 * close, and the same fetch policy as a plain fetch: route interception checks
 * each request's URL (the full checkUrl for the page itself; the host rules
 * for what the page loads) and drops images, media and fonts, and every
 * connection goes through a local PolicyProxy that checks its host and DNS
 * answers, redirect hops included. Route interception never sees the redirect
 * hops Chromium follows itself, so each document request of the top frame,
 * every hop of its redirects included, is checked with the full checkUrl over
 * the DevTools protocol (guardNavigation): a page that redirects to a
 * token-like URL is skipped, as safeFetch skips it. So is a page whose script
 * or meta refresh navigates to one later: what the top frame shows at the end
 * (Chrome's error page, or the proxy's 403) is never taken for the page.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkUrl, fetchConfig, USER_AGENT, type FetchConfig, type FetchOutcome, type SkipReason } from "./fetch.js";
import { PolicyProxy } from "./policy-proxy.js";

/** A page gets this long to load and settle, all told. */
export const RENDER_TIMEOUT_MS = 20_000;
/** After the page's DOM is loaded, wait for the network to go idle, but no longer than this. */
export const SETTLE_MS = 3_000;
/** Pages open in the browser at once. */
export const BROWSER_PAGES = 2;
/** Rendered HTML longer than this is not extracted (the plain fetch's size cap, in characters). */
export const MAX_RENDERED_CHARS = 5 * 1024 * 1024;

/** A top-frame document request the fetch policy refused: where it went, and why. */
interface RefusedNavigation {
  url: string;
  reason: SkipReason;
}

/**
 * Checks every document request of the page's top frame with the full
 * checkUrl, redirect hops included, and fails those it refuses; `refused`
 * gets the latest one. Route interception sees only the first request of a
 * redirect chain, and the proxy only each hop's host, so without this a page
 * that redirects to /logout?token=… would be requested by the browser.
 */
async function guardNavigation(
  context: PwContext,
  page: PwPage,
  config: () => FetchConfig,
  refused: (navigation: RefusedNavigation) => void,
): Promise<void> {
  const session = await context.newCDPSession(page);
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
  const top = frameTree.frame.id;
  session.on("Fetch.requestPaused", (event) => {
    const check = event.frameId === top ? checkUrl(event.request.url, config()) : { ok: true as const };
    if (check.ok) {
      session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
      return;
    }
    refused({ url: event.request.url, reason: check.reason });
    session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
}

/** Requests the browser never makes: nothing in them is text. */
const BLOCKED_TYPES = new Set(["image", "media", "font"]);

// --- finding a browser -------------------------------------------------------

/** Playwright's Chrome and Edge channels, in the order tried, with where each installs. */
const CHANNELS: { name: string; paths: Partial<Record<NodeJS.Platform, string>> }[] = [
  {
    name: "chrome",
    paths: {
      linux: "/opt/google/chrome/chrome",
      darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      win32: "\\Google\\Chrome\\Application\\chrome.exe",
    },
  },
  {
    name: "chrome-beta",
    paths: {
      linux: "/opt/google/chrome-beta/chrome",
      darwin: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      win32: "\\Google\\Chrome Beta\\Application\\chrome.exe",
    },
  },
  {
    name: "chrome-dev",
    paths: {
      linux: "/opt/google/chrome-unstable/chrome",
      darwin: "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      win32: "\\Google\\Chrome Dev\\Application\\chrome.exe",
    },
  },
  {
    name: "chrome-canary",
    paths: {
      linux: "/opt/google/chrome-canary/chrome",
      darwin: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      win32: "\\Google\\Chrome SxS\\Application\\chrome.exe",
    },
  },
  {
    name: "msedge",
    paths: {
      linux: "/opt/microsoft/msedge/msedge",
      darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      win32: "\\Microsoft\\Edge\\Application\\msedge.exe",
    },
  },
];

/**
 * Chromium and Brave, where their installers and package managers put them.
 * Paths starting with ~ are under the home directory; on Windows they are
 * under each of the install prefixes, as Playwright's channels are.
 */
const KNOWN_PATHS: { name: string; paths: Partial<Record<NodeJS.Platform, string[]>> }[] = [
  {
    name: "chromium",
    paths: {
      darwin: [
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "~/Applications/Chromium.app/Contents/MacOS/Chromium",
      ],
      linux: [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/lib/chromium/chromium",
        "/usr/lib/chromium-browser/chromium-browser",
        "/snap/bin/chromium",
      ],
      win32: ["\\Chromium\\Application\\chrome.exe"],
    },
  },
  {
    name: "brave",
    paths: {
      darwin: [
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "~/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ],
      linux: ["/usr/bin/brave-browser", "/usr/bin/brave", "/opt/brave.com/brave/brave", "/snap/bin/brave"],
      win32: ["\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    },
  },
];

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** Whether an executable file is at this path. */
  exists?: (file: string) => boolean;
}

export type BrowserResolution =
  /** `source`: MNEMOS_BROWSER, a Playwright channel name, "chromium" or "brave". */
  | { ok: true; executablePath: string; source: string }
  /** off: MNEMOS_BROWSER=0. missing: MNEMOS_BROWSER names no file. none: nothing found. */
  | { ok: false; why: "off" | "missing" | "none"; reason: string };

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Where Windows installs per user and per machine, as Playwright looks for its channels. */
function windowsPrefixes(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA,
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files`,
    env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files (x86)`,
  ].filter((prefix): prefix is string => Boolean(prefix));
}

/**
 * The Chromium-based browser to render pages with, tried in this order:
 * MNEMOS_BROWSER (the path to any Chromium-based browser's executable; 0
 * turns rendering off); Playwright's channels chrome, chrome-beta,
 * chrome-dev, chrome-canary and msedge, where Playwright looks for them;
 * then Chromium and Brave where they install on this OS. A MNEMOS_BROWSER
 * that names no file is an error, not a reason to pick another browser.
 */
export function resolveBrowser(deps: ResolveDeps = {}): BrowserResolution {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.homedir ?? os.homedir();
  const exists = deps.exists ?? isExecutable;
  const join = platform === "win32" ? path.win32.join : path.posix.join;

  const configured = env.MNEMOS_BROWSER?.trim();
  if (configured === "0") return { ok: false, why: "off", reason: "MNEMOS_BROWSER=0 turns page rendering off" };
  if (configured) {
    if (exists(configured)) return { ok: true, executablePath: configured, source: "MNEMOS_BROWSER" };
    return { ok: false, why: "missing", reason: `MNEMOS_BROWSER: no browser at ${configured}` };
  }

  const prefixes = platform === "win32" ? windowsPrefixes(env) : [""];
  const under = (suffix: string) => prefixes.map((prefix) => (prefix ? join(prefix, suffix) : suffix));
  for (const channel of CHANNELS) {
    const suffix = channel.paths[platform];
    if (!suffix) continue;
    const found = under(suffix).find(exists);
    if (found) return { ok: true, executablePath: found, source: channel.name };
  }
  for (const browser of KNOWN_PATHS) {
    for (const known of browser.paths[platform] ?? []) {
      const candidates = known.startsWith("~/") ? [join(home, known.slice(2))] : platform === "win32" ? under(known) : [known];
      const found = candidates.find(exists);
      if (found) return { ok: true, executablePath: found, source: browser.name };
    }
  }
  return { ok: false, why: "none", reason: "no Chromium-based browser found" };
}

// --- the browser ---------------------------------------------------------------

/** The parts of playwright-core used here. */
export interface PlaywrightModule {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<PwContext>;
  };
}

interface PwContext {
  route(url: string, handler: (route: PwRoute) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
  newCDPSession(page: PwPage): Promise<PwCDPSession>;
  close(): Promise<void>;
}

/** A DevTools protocol session for one page (Chromium only, which is all mnemos launches). */
interface PwCDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "Fetch.requestPaused", handler: (event: RequestPaused) => void): void;
}

/** The parts of the protocol's Fetch.requestPaused event used here. */
interface RequestPaused {
  requestId: string;
  request: { url: string };
  frameId: string;
}

interface PwRoute {
  request(): PwRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

interface PwRequest {
  url(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  frame(): { parentFrame(): unknown };
}

interface PwPage {
  goto(url: string, options: Record<string, unknown>): Promise<PwResponse | null>;
  waitForLoadState(state: string, options: Record<string, unknown>): Promise<void>;
  content(): Promise<string>;
  url(): string;
  on(event: "popup", handler: (popup: PwPage) => void): void;
  on(event: "response", handler: (response: PwResponse) => void): void;
  close(): Promise<void>;
}

interface PwResponse {
  status(): number;
  request(): PwRequest;
}

/** Whether a request is the page itself: a navigation of the top frame. */
function isPage(request: PwRequest): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false; // a request with no frame (a worker's) is not the page itself
  }
}

/**
 * Why pages cannot be rendered in this process: the hint completes "N pages
 * need a browser; …" in the status.
 */
export interface Unavailable {
  ok: false;
  reason: string;
  hint: string;
}

export type LaunchResult = { ok: true } | Unavailable;

/** What the fetcher renders pages with; HeadlessBrowser, or a test's fake. */
export interface PageRenderer {
  /** Launches the browser if it is not running; the answer for an unavailable browser is kept for the process. */
  launch(): Promise<LaunchResult>;
  /** Loads a page and returns its rendered HTML as a fetch outcome; never throws. */
  render(url: string, options: { config: FetchConfig; signal?: AbortSignal }): Promise<FetchOutcome>;
  /** Closes the browser, if running; launch() starts a new one. */
  close(): Promise<void>;
}

export interface HeadlessBrowserOptions {
  /** MNEMOS_BROWSER and, for the proxy before the first render, the fetch policy. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Finds the browser; defaults to resolveBrowser({ env }). */
  resolve?: () => BrowserResolution;
  /** Loads playwright-core; defaults to import("playwright-core"). */
  importPlaywright?: () => Promise<PlaywrightModule>;
  /** Where the temporary profile goes; defaults to os.tmpdir(). */
  tmpDir?: string;
  timeoutMs?: number;
  settleMs?: number;
}

const PLAYWRIGHT = "playwright-core"; // a variable, so tsc does not need the optional package to build

/** The outcome for a page whose HTTP status is not a success, or undefined. */
function httpOutcome(code: number, url: string): FetchOutcome | undefined {
  if (code === 403 || code === 429) return { status: "refused", httpStatus: code, url };
  if (code < 200 || code >= 300) return { status: "failed", reason: "http-error", url, httpStatus: code };
  return undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

interface Running {
  context: PwContext;
  proxy: PolicyProxy;
  profile: string;
  cleanup: () => void;
}

/**
 * A headless Chromium-based browser for rendering pages, launched on first
 * use and closed by close(). One browser, and one profile, per launch.
 */
export class HeadlessBrowser implements PageRenderer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolve: () => BrowserResolution;
  private readonly importPlaywright: () => Promise<PlaywrightModule>;
  private readonly tmpDir: string;
  private readonly timeoutMs: number;
  private readonly settleMs: number;
  /** The fetch policy of the latest render; the route and the proxy read it. */
  private config: FetchConfig;
  private unavailable: Unavailable | undefined;
  private running: Promise<Running | Unavailable> | undefined;

  constructor(options: HeadlessBrowserOptions = {}) {
    this.env = options.env ?? process.env;
    const env = this.env;
    this.resolve = options.resolve ?? (() => resolveBrowser({ env }));
    this.importPlaywright = options.importPlaywright ?? (() => import(PLAYWRIGHT) as Promise<PlaywrightModule>);
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.config = fetchConfig(this.env);
  }

  /** The profile directory of the running browser, if any; for tests. */
  async profileDir(): Promise<string | undefined> {
    const running = await this.running;
    return running && "context" in running ? running.profile : undefined;
  }

  async launch(): Promise<LaunchResult> {
    if (this.unavailable) return this.unavailable;
    this.running ??= this.start();
    const running = await this.running;
    if ("context" in running) return { ok: true };
    this.unavailable = running;
    this.running = undefined;
    return running;
  }

  private async start(): Promise<Running | Unavailable> {
    const found = this.resolve();
    if (!found.ok) {
      const hint = found.why === "none" ? "set MNEMOS_BROWSER" : found.reason;
      return { ok: false, reason: found.reason, hint };
    }
    let playwright: PlaywrightModule;
    try {
      playwright = await this.importPlaywright();
    } catch (err) {
      return {
        ok: false,
        reason: `playwright-core is not installed: ${message(err)}`,
        hint: "playwright-core is not installed",
      };
    }
    const proxy = new PolicyProxy({ config: () => this.config });
    let profile: string | undefined;
    try {
      const server = await proxy.listen();
      profile = fs.mkdtempSync(path.join(this.tmpDir, "mnemos-browser-"));
      const context = await playwright.chromium.launchPersistentContext(profile, {
        executablePath: found.executablePath,
        headless: true,
        proxy: { server },
        userAgent: USER_AGENT,
        acceptDownloads: false,
        serviceWorkers: "block",
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--no-first-run"],
      });
      await context.route("**/*", (route) => this.filter(route));
      const dir = profile;
      // If mnemos exits with the browser open, its profile goes too (Playwright kills the browser).
      const cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      process.once("exit", cleanup);
      return { context, proxy, profile, cleanup };
    } catch (err) {
      proxy.close();
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
      const reason = `${found.executablePath} did not start: ${message(err)}`;
      return { ok: false, reason, hint: reason };
    }
  }

  /** The route handler: drops images, media and fonts, and requests the fetch policy refuses. */
  private filter(route: PwRoute): Promise<void> {
    const request = route.request();
    const abort = () => route.abort("blockedbyclient").catch(() => undefined);
    if (BLOCKED_TYPES.has(request.resourceType())) return abort();
    const check = checkUrl(request.url(), this.config);
    if (!check.ok) {
      // Token-like URLs are kept from the bookmark itself; what a page loads in a
      // fresh profile with no session carries the page's own keys, not the user's.
      if (isPage(request) || check.reason !== "token-like") return abort();
    }
    return route.continue().catch(() => undefined);
  }

  async render(url: string, options: { config: FetchConfig; signal?: AbortSignal }): Promise<FetchOutcome> {
    this.config = options.config;
    const started = Date.now();
    const first = checkUrl(url, options.config);
    if (!first.ok) return { status: "skipped", reason: first.reason, url };
    const launched = await this.launch();
    if (!launched.ok) return { status: "failed", reason: "connection", url, detail: launched.reason };
    const running = (await this.running) as Running;
    const { signal } = options;
    if (signal?.aborted) return { status: "failed", reason: "aborted", url };
    let page: PwPage | undefined;
    const closePage = () => void page?.close().catch(() => undefined);
    signal?.addEventListener("abort", closePage, { once: true });
    const remaining = () => Math.max(1, this.timeoutMs - (Date.now() - started));
    let current = url;
    let refused: RefusedNavigation | undefined;
    try {
      page = await running.context.newPage();
      // A window the page opens is closed: only the page itself is rendered.
      page.on("popup", (popup) => void popup.close().catch(() => undefined));
      // The HTTP status of the document the top frame shows: the page's, or that of
      // where its script or a meta refresh went (the proxy's 403 when it refused it).
      let code = 200;
      page.on("response", (response) => {
        if (isPage(response.request())) code = response.status();
      });
      await guardNavigation(running.context, page, () => this.config, (navigation) => (refused = navigation));
      if (signal?.aborted) return { status: "failed", reason: "aborted", url };
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });
      } catch (err) {
        // A redirect the policy refused: skipped, as safeFetch skips it.
        if (refused) return { status: "skipped", reason: refused.reason, url: refused.url };
        throw err;
      }
      current = page.url();
      const unwanted = httpOutcome(code, current);
      if (unwanted) return unwanted;
      await page
        .waitForLoadState("networkidle", { timeout: Math.min(this.settleMs, remaining()) })
        .catch(() => undefined); // still loading after the settle delay: take the page as it is
      const html = await page.content();
      current = page.url();
      // The page's own script or a meta refresh navigated the top frame on: to a
      // URL the policy refused (what is left is Chrome's error page or the proxy's
      // refusal, not the page), or to one that did not load.
      if (refused) return { status: "skipped", reason: refused.reason, url: refused.url };
      if (current.startsWith("chrome-error:")) return { status: "failed", reason: "connection", url, detail: "the page navigated to an error page" };
      const navigated = httpOutcome(code, current);
      if (navigated) return navigated;
      if (html.length > MAX_RENDERED_CHARS) return { status: "failed", reason: "too-large", url: current };
      return { status: "ok", kind: "html", url: current, httpStatus: code, contentType: "text/html", charset: "utf-8", html };
    } catch (err) {
      if (signal?.aborted) return { status: "failed", reason: "aborted", url: current };
      if ((err as { name?: string })?.name === "TimeoutError") return { status: "failed", reason: "timeout", url: current };
      return { status: "failed", reason: "connection", url: current, detail: message(err) };
    } finally {
      signal?.removeEventListener("abort", closePage);
      await page?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const pending = this.running;
    this.running = undefined;
    const running = await pending;
    if (!running || !("context" in running)) return;
    await running.context.close().catch(() => undefined);
    running.proxy.close();
    process.off("exit", running.cleanup);
    try {
      running.cleanup();
    } catch {
      // a profile left in the temporary directory
    }
  }
}
