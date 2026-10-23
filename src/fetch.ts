/**
 * Page fetch policy and a safe fetch wrapper. Decides whether a bookmark's
 * page may be fetched at all (scheme, token-like URLs, skipped domains and
 * folders, private addresses) and fetches it under hard limits: https first,
 * at most five manually followed redirects re-checked hop by hop, a per-page
 * timeout, a response size cap, and HTML or PDF content only (a PDF comes
 * back as bytes, for pdf.ts to read). No scheduling here — callers decide
 * when and how often.
 *
 * Two deliberate choices, also stated in the README:
 *
 * - robots.txt is not consulted. mnemos fetches pages the user saved
 *   themselves, one at a time, the way their browser would; it does not
 *   crawl or follow links.
 * - 403 and 429 come back as status "refused" and are never retried here.
 *   With a browser-like User-Agent, mnemos must not look like a crawler that
 *   ignores refusals; the caller's backoff decides whether to try again.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { domainToASCII } from "node:url";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { decodeHtml } from "./charset.js";
import { folderMatches } from "./lib.js";
import { looksLikePdf } from "./pdf.js";

/** Why a page is not fetched: a policy decision, not a failure. */
export type SkipReason =
  | "invalid-url"
  | "scheme"
  | "token-like"
  | "skip-domain"
  | "skip-folder"
  | "private-address"
  /** Neither an HTML page nor (when accepted) a PDF. */
  | "not-html";

/** Why a fetch that was allowed did not produce a page. */
export type FailReason =
  | "dns"
  | "connection"
  | "timeout"
  | "too-large"
  | "too-many-redirects"
  | "bad-redirect"
  | "http-error"
  /** The caller's signal aborted the fetch (mnemos is shutting down). */
  | "aborted";

export type FetchOutcome =
  | {
      status: "ok";
      kind: "html";
      /** The URL the page was finally served from, after upgrades and redirects. */
      url: string;
      httpStatus: number;
      contentType: string;
      /** The encoding the page was decoded with (canonical name): see charset.ts. */
      charset: string;
      html: string;
    }
  | {
      status: "ok";
      kind: "pdf";
      url: string;
      httpStatus: number;
      contentType: string;
      /** The file as served (decompressed), checked to start with a PDF header. */
      pdf: Uint8Array;
    }
  | { status: "skipped"; reason: SkipReason; url: string }
  /** 403 or 429: the site said no. Not retried here; see the module comment. */
  | { status: "refused"; httpStatus: number; url: string; retryAfterMs?: number }
  | { status: "failed"; reason: FailReason; url: string; httpStatus?: number; detail?: string };

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
/**
 * How long the https attempt for an http:// bookmark may take to connect and
 * finish its TLS handshake. A site whose port 443 silently drops packets
 * would otherwise use up the whole page timeout and never get its http
 * fallback; past this, the attempt counts as a connection failure.
 */
export const UPGRADE_CONNECT_TIMEOUT_MS = 5_000;

/** A current desktop Chrome User-Agent (Chrome's reduced UA format). */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
/** Generic download types some servers send PDFs as: taken only for a path ending in .pdf. */
const BINARY_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/download",
  "application/x-download",
  "application/force-download",
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FetchConfig {
  /** MNEMOS_SKIP_DOMAINS, ASCII (punycode), lowercase; each also covers its subdomains. */
  skipDomains: string[];
  /** MNEMOS_SKIP_FOLDERS, matched with lib.folderMatches. */
  skipFolders: string[];
  /** MNEMOS_FETCH_ALLOW_HOSTS: `host` or `host:port`, exempt from the private-address block. */
  allowHosts: { host: string; port?: string }[];
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lowercase, no trailing dot, no IPv6 brackets: the form hosts are compared in. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

export function fetchConfig(env: NodeJS.ProcessEnv = process.env): FetchConfig {
  const skipDomains = list(env.MNEMOS_SKIP_DOMAINS)
    .map((d) => normalizeHost(d.replace(/^\*?\./, "")))
    .map((d) => domainToASCII(d) || d)
    .filter(Boolean);
  const allowHosts = list(env.MNEMOS_FETCH_ALLOW_HOSTS).map((entry) => {
    // "[::1]:8080", "[::1]", "::1", "host:8080", "host"
    const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) return { host: normalizeHost(bracketed[1]), port: bracketed[2] };
    if (net.isIPv6(entry)) return { host: normalizeHost(entry) };
    const withPort = entry.match(/^(.+):(\d+)$/);
    if (withPort) return { host: hostKey(withPort[1]), port: withPort[2] };
    return { host: hostKey(entry) };
  });
  return { skipDomains, skipFolders: list(env.MNEMOS_SKIP_FOLDERS), allowHosts };
}

function hostKey(host: string): string {
  const h = normalizeHost(host);
  return domainToASCII(h) || h;
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function isAllowedHost(url: URL, config: FetchConfig): boolean {
  const host = normalizeHost(url.hostname);
  const port = effectivePort(url);
  return config.allowHosts.some((a) => a.host === host && (a.port === undefined || a.port === port));
}

/** Accept-Language from the system locale, with English as the fallback. */
export function acceptLanguage(
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): string {
  const tags: string[] = [];
  const add = (tag: string) => {
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  };
  // Drop Unicode extensions ("de-DE-u-co-phonebk") and anything unusable.
  const base = locale.split("-u-")[0].split("-x-")[0];
  if (/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(base) && base.toLowerCase() !== "und") {
    add(base);
    add(base.split("-")[0].toLowerCase());
  }
  add("en");
  return tags.map((t, i) => (i === 0 ? t : `${t};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(",");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function ipv4Octets(address: string): number[] | null {
  if (!net.isIPv4(address)) return null;
  return address.split(".").map(Number);
}

function isBlockedIPv4(o: number[]): boolean {
  const [a, b] = o;
  return (
    a === 0 || // "this network", including the unspecified 0.0.0.0
    a === 127 || // loopback
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, private to the ISP
  );
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function ipv6Groups(address: string): number[] | null {
  const addr = address.replace(/%.*$/, ""); // zone id, as in fe80::1%en0
  if (!net.isIPv6(addr)) return null;
  let text = addr;
  const tail: number[] = [];
  const v4 = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[2].split(".").map(Number);
    tail.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
    text = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const [head, rest] = text.split("::");
  const parse = (s: string | undefined) => (s ? s.split(":").filter(Boolean).map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = [...parse(rest), ...tail];
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill(0);
  const groups = [...left, ...fill, ...right];
  return groups.length === 8 ? groups : null;
}

/**
 * True for addresses mnemos must not connect to: loopback, private,
 * link-local, unspecified and carrier-grade NAT, in IPv4 or IPv6, including
 * IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64 and 6to4).
 * Anything that is not an IP address at all is blocked too.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) return isBlockedIPv4(v4);
  const g = ipv6Groups(address);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if (zeros(5) && g[5] === 0xffff) return isBlockedIPv4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeros(6)) return isBlockedIPv4(embedded(g[6], g[7])); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(embedded(g[6], g[7])); // NAT64 64:ff9b::/96
  }
  if (g[0] === 0x2002) return isBlockedIPv4(embedded(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}

/** Names that only ever mean "this machine" or "this local network". */
export function isLocalName(hostname: string): boolean {
  const h = normalizeHost(hostname);
  return h === "localhost" || h.endsWith(".localhost") || h === "local" || h.endsWith(".local");
}

// ---------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------

const TOKEN_PARAMS = new Set([
  "token",
  "key",
  "apikey",
  "sig",
  "signature",
  "code",
  "auth",
  "session",
  "sid",
  "otp",
  "password",
  "secret",
]);

const TOKEN_SEGMENTS = [
  "unsubscribe",
  "logout",
  "signout",
  "sign-out",
  "delete",
  "confirm",
  "verify",
  "magic",
  "activate",
];

/**
 * A query parameter name is token-like when it, or one of its words, is in
 * TOKEN_PARAMS: words are split on punctuation and camelCase, so
 * `access_token`, `X-Amz-Signature`, `apiKey` and `API_KEY` all match, while
 * `keyword` or `codec` do not.
 */
function isTokenParam(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (TOKEN_PARAMS.has(compact)) return true;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => TOKEN_PARAMS.has(w));
}

/**
 * True for URLs that look like they carry a credential or trigger an action
 * (one-time links, unsubscribe and logout links): fetching one could sign the
 * user out, confirm something on their behalf, or leak a secret into an index.
 */
export function isTokenLike(url: URL): boolean {
  if (url.username || url.password) return true;
  for (const name of url.searchParams.keys()) {
    if (isTokenParam(name)) return true;
  }
  for (const raw of url.pathname.split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // keep the raw segment
    }
    segment = segment.toLowerCase();
    if (TOKEN_SEGMENTS.some((word) => segment.includes(word))) return true;
  }
  return false;
}

export function isSkippedDomain(hostname: string, config: FetchConfig): boolean {
  const host = hostKey(hostname);
  return config.skipDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function isSkippedFolder(folder: string, config: FetchConfig): boolean {
  return config.skipFolders.some((needle) => folderMatches(folder, needle));
}

export type PolicyResult = { ok: true; url: URL } | { ok: false; reason: SkipReason };

/**
 * The rules a URL must pass before any network access: scheme, token-like,
 * skipped domain, and a host that is a literal private address or a local
 * name. Every redirect hop is checked against the same rules. The bookmark's
 * folder is checked only when given — for the first URL, not for redirects.
 * DNS answers are checked separately, at connect time.
 */
export function checkUrl(
  input: string | URL,
  config: FetchConfig = fetchConfig(),
  folder?: string,
): PolicyResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (folder !== undefined && isSkippedFolder(folder, config)) return { ok: false, reason: "skip-folder" };
  if (isSkippedDomain(url.hostname, config)) return { ok: false, reason: "skip-domain" };
  if (isTokenLike(url)) return { ok: false, reason: "token-like" };
  if (!isAllowedHost(url, config)) {
    const host = normalizeHost(url.hostname);
    if (net.isIP(host) ? isBlockedAddress(host) : isLocalName(host)) {
      return { ok: false, reason: "private-address" };
    }
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a host name to every address it has, like dns.lookup with `all`. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

export type Resolution =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; reason: "private-address" | "dns"; detail?: string };

/**
 * Every address the host resolves to must be public (unless the host is in
 * MNEMOS_FETCH_ALLOW_HOSTS): one private answer among public ones is enough
 * to refuse, since the connection could land on any of them. `allowAs` is the
 * URL matched against the allow list: the bookmark's own URL for its https
 * upgrade, so allowing `intranet:80` also covers the attempt on port 443.
 */
export async function resolveChecked(
  url: URL,
  allowAs: URL,
  config: FetchConfig,
  resolve: Resolver,
): Promise<Resolution> {
  const host = normalizeHost(url.hostname);
  const allowed = isAllowedHost(allowAs, config);
  if (net.isIP(host)) {
    if (!allowed && isBlockedAddress(host)) return { ok: false, reason: "private-address" };
    return { ok: true, addresses: [{ address: host, family: net.isIP(host) }] };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch (e) {
    return { ok: false, reason: "dns", detail: String(e) };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns", detail: "no addresses" };
  if (!allowed && addresses.some((a) => isBlockedAddress(a.address))) {
    return { ok: false, reason: "private-address" };
  }
  return { ok: true, addresses };
}

/**
 * A `lookup` for http.request that hands back only the addresses already
 * checked, so a second DNS answer cannot swap in a private one between the
 * check and the connect (DNS rebinding).
 */
export function pinnedLookup(addresses: ResolvedAddress[]): net.LookupFunction {
  return ((_hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
    const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    if (usable.length === 0) {
      const err = Object.assign(new Error("no checked address for this family"), { code: "ENOTFOUND" });
      callback(err, options.all ? [] : undefined);
      return;
    }
    if (options.all) callback(null, usable);
    else callback(null, usable[0].address, usable[0].family);
  }) as unknown as net.LookupFunction;
}

// ---------------------------------------------------------------------------
// The fetch wrapper
// ---------------------------------------------------------------------------

export interface FetchOptions {
  /** The bookmark's folder path, checked against MNEMOS_SKIP_FOLDERS. */
  folder?: string;
  config?: FetchConfig;
  resolve?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  /** Overrides UPGRADE_CONNECT_TIMEOUT_MS. */
  upgradeConnectTimeoutMs?: number;
  /**
   * Extra trusted CA certificates for https (an intranet CA, or a test's),
   * added to Node's bundled roots rather than replacing them.
   */
  ca?: string | Buffer | Array<string | Buffer>;
  /**
   * Fetch PDFs too (default true): pass false when no PDF parser is
   * available (pdf.pdfSupport), and PDFs are skipped as not-html unread.
   */
  acceptPdf?: boolean;
  /** Aborts the fetch from outside (shutdown): it then ends as failed, reason "aborted". */
  signal?: AbortSignal;
}

class StopError extends Error {
  constructor(readonly outcome: FetchOutcome) {
    super(outcome.status);
  }
}

type Response = { res: http.IncomingMessage; url: URL };

/**
 * One request to one URL: resolve and check, connect to a checked address,
 * and wait for the response headers. Errors before the headers arrive (TLS,
 * refused or reset connections) reject with the original error.
 */
async function request(
  url: URL,
  opts: FetchOptions & { config: FetchConfig; resolve: Resolver; signal: AbortSignal },
  allowAs: URL = url,
  connectTimeoutMs?: number,
): Promise<Response> {
  const resolution = await resolveChecked(url, allowAs, opts.config, opts.resolve);
  if (!resolution.ok) {
    throw new StopError(
      resolution.reason === "dns"
        ? { status: "failed", reason: "dns", url: url.href, detail: resolution.detail }
        : { status: "skipped", reason: "private-address", url: url.href },
    );
  }
  const lib = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup(resolution.addresses),
        signal: opts.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            opts.acceptPdf === false
              ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
              : "text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8",
          "Accept-Language": acceptLanguage(),
          "Accept-Encoding": "gzip, deflate, br",
        },
        ...(url.protocol === "https:" && opts.ca
          ? { ca: [...tls.rootCertificates, ...([] as Array<string | Buffer>).concat(opts.ca)] }
          : {}),
      },
      (res) => resolve({ res, url }),
    );
    req.on("error", reject);
    if (connectTimeoutMs !== undefined) {
      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error("connect or TLS handshake timed out"), { code: "ECONNTIMEOUT" }));
      }, connectTimeoutMs);
      req.on("socket", (socket) => {
        socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(timer));
      });
      req.on("close", () => clearTimeout(timer));
    }
    req.end();
  });
}

/** The media type, lowercased, and the charset parameter as given, if there is one. */
function parseContentType(header: string | undefined): { type: string; charset?: string } {
  const [type, ...params] = (header ?? "").split(";");
  let charset: string | undefined;
  for (const p of params) {
    const m = p.trim().match(/^charset=["']?([^"']+)["']?$/i);
    if (m) charset = m[1].trim();
  }
  return { type: type.trim().toLowerCase(), charset };
}

function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Decodes a Content-Encoding: deflate body, which servers send either
 * zlib-wrapped (RFC 1950, as HTTP says) or as raw deflate (RFC 1951); browsers
 * take both. The first two bytes tell them apart: a zlib header has CM = 8 in
 * the low nibble of the first, and the two read as a big-endian number are a
 * multiple of 31.
 */
class DeflateDecoder extends Transform {
  private head = Buffer.alloc(0);
  private inflate?: zlib.Inflate | zlib.InflateRaw;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (!this.inflate) {
      this.head = Buffer.concat([this.head, chunk]);
      if (this.head.length < 2) return done();
      chunk = this.head;
      this.start();
    }
    this.inflate!.write(chunk);
    done();
  }

  override _flush(done: TransformCallback): void {
    // An empty body decodes to an empty body.
    if (!this.inflate && this.head.length === 0) return done();
    if (!this.inflate) {
      this.start();
      this.inflate!.write(this.head);
    }
    this.inflate!.once("end", () => done());
    this.inflate!.end();
  }

  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    this.inflate?.destroy();
    done(error);
  }

  private start(): void {
    const [b0, b1] = this.head;
    const zlibWrapped =
      this.head.length >= 2 && (b0 & 0x0f) === 8 && (b0 * 256 + b1) % 31 === 0;
    const inflate = zlibWrapped ? zlib.createInflate() : zlib.createInflateRaw();
    inflate.on("data", (data: Buffer) => this.push(data));
    inflate.on("error", (e) => this.destroy(e));
    this.inflate = inflate;
  }
}

/** Reads the (decompressed) body, aborting once it passes `maxBytes`. */
function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  let stream: Readable = res;
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
  else if (encoding === "deflate") stream = res.pipe(new DeflateDecoder());
  else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        if (stream !== res) stream.destroy();
        reject(new StopError({ status: "failed", reason: "too-large", url }));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    res.on("error", reject);
    // A connection that closes mid-body, or the page timeout, must not leave
    // this promise pending; once settled, later rejections are no-ops.
    res.on("close", () => {
      if (!res.complete) reject(new Error("connection closed before the body ended"));
    });
    signal.addEventListener("abort", () => {
      res.destroy();
      reject(signal.reason);
    });
  });
}

function isTimeout(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e as { name?: string })?.name === "AbortError";
}

/**
 * Fetches a bookmarked page under every rule of the fetch policy and returns
 * what happened as data; it never throws for network or policy reasons.
 *
 * An http:// URL is tried as https:// first, falling back to the original
 * only when that attempt fails to connect or to set up TLS, or takes longer
 * than UPGRADE_CONNECT_TIMEOUT_MS to — never on an HTTP status. Redirects are followed by hand, at most MAX_REDIRECTS hops, each
 * checked against the same rules as the first URL and taken as given (a
 * redirect to http:// is not upgraded). One timeout covers the whole page:
 * attempts, redirects and the body.
 */
export async function safeFetch(input: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const config = options.config ?? fetchConfig();
  const resolve = options.resolve ?? systemResolver;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const outer = options.signal;
  const abortFromOutside = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", abortFromOutside, { once: true });
  const opts = { ...options, config, resolve, signal: controller.signal };
  let current = input;
  try {
    const first = checkUrl(input, config, options.folder);
    if (!first.ok) return { status: "skipped", reason: first.reason, url: input };
    let url = first.url;

    let response: Response;
    if (url.protocol === "http:") {
      const upgraded = new URL(url.href);
      upgraded.protocol = "https:";
      current = upgraded.href;
      try {
        response = await request(
          upgraded,
          opts,
          url,
          options.upgradeConnectTimeoutMs ?? UPGRADE_CONNECT_TIMEOUT_MS,
        );
      } catch (e) {
        if (e instanceof StopError || isTimeout(e, controller.signal)) throw e;
        current = url.href;
        response = await request(url, opts); // TLS or connection failure: plain http
      }
    } else {
      current = url.href;
      response = await request(url, opts);
    }

    for (let hops = 0; ; hops++) {
      const { res } = response;
      url = response.url;
      current = url.href;
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && code !== 304) {
        res.destroy();
        const location = res.headers.location;
        if (!location) return { status: "failed", reason: "bad-redirect", url: current, httpStatus: code };
        if (hops >= MAX_REDIRECTS) {
          return { status: "failed", reason: "too-many-redirects", url: current, httpStatus: code };
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { status: "failed", reason: "bad-redirect", url: current, httpStatus: code };
        }
        const check = checkUrl(next, config);
        if (!check.ok) return { status: "skipped", reason: check.reason, url: next.href };
        current = next.href;
        response = await request(next, opts);
        continue;
      }
      if (code === 403 || code === 429) {
        res.destroy();
        const retry = retryAfterMs(res.headers["retry-after"]);
        return { status: "refused", httpStatus: code, url: current, ...(retry !== undefined ? { retryAfterMs: retry } : {}) };
      }
      if (code < 200 || code >= 300) {
        res.destroy();
        return { status: "failed", reason: "http-error", url: current, httpStatus: code };
      }
      const { type, charset } = parseContentType(res.headers["content-type"]);
      const pdf =
        options.acceptPdf !== false &&
        (PDF_TYPES.has(type) || (BINARY_TYPES.has(type) && /\.pdf$/i.test(url.pathname)));
      if (!HTML_TYPES.has(type) && !pdf) {
        res.destroy();
        return { status: "skipped", reason: "not-html", url: current };
      }
      const declared = Number(res.headers["content-length"]);
      if (!res.headers["content-encoding"] && Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        return { status: "failed", reason: "too-large", url: current };
      }
      const body = await readBody(res, maxBytes, current, controller.signal);
      if (pdf) {
        // A login or error page served as a PDF, or some other download.
        if (!looksLikePdf(body)) return { status: "skipped", reason: "not-html", url: current };
        return { status: "ok", kind: "pdf", url: current, httpStatus: code, contentType: "application/pdf", pdf: body };
      }
      const decoded = decodeHtml(body, charset);
      return { status: "ok", kind: "html", url: current, httpStatus: code, contentType: type, ...decoded };
    }
  } catch (e) {
    if (e instanceof StopError) return e.outcome;
    if (outer?.aborted) return { status: "failed", reason: "aborted", url: current };
    if (isTimeout(e, controller.signal)) return { status: "failed", reason: "timeout", url: current };
    return { status: "failed", reason: "connection", url: current, detail: String(e) };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abortFromOutside);
  }
}
