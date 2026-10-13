/**
 * A local HTTP proxy that holds the headless browser (headless.ts) to the
 * fetch policy at the connection level: every connection the browser opens,
 * plain http requests and https/wss tunnels (CONNECT) alike, is checked like
 * safeFetch checks a request — the host must pass checkUrl, and every address
 * it resolves to must be public unless MNEMOS_FETCH_ALLOW_HOSTS allows it —
 * and then goes to an address that was checked, never to a second DNS answer.
 *
 * Why a proxy: Playwright's request interception (route) sees the first
 * request of each chain only. Chromium follows redirects itself, so a page
 * (or one of its scripts) answered by a 302 to a private address would reach
 * it unseen. Through the proxy, each hop is a new connection and is checked.
 * Playwright makes Chromium send loopback traffic through the proxy too
 * (`<-loopback>`), so localhost is no way around it.
 *
 * The proxy listens on 127.0.0.1 only. A blocked plain http request gets a
 * 403 from the proxy; a blocked tunnel is refused, which the browser reports
 * as a failed request.
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import {
  checkUrl,
  fetchConfig,
  pinnedLookup,
  resolveChecked,
  systemResolver,
  type FetchConfig,
  type Resolver,
} from "./fetch.js";

/** A connection the proxy refused, and why. */
export interface BlockedConnection {
  host: string;
  reason: string;
}

/** How many refused connections are remembered, for diagnostics and tests. */
const MAX_BLOCKED = 100;

/** Request headers that are about the hop to the proxy, not the request. */
const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive"]);

export interface PolicyProxyOptions {
  /** The policy to apply, read at each connection; defaults to fetchConfig(). */
  config?: () => FetchConfig;
  resolve?: Resolver;
}

type Check = { ok: true; address: string; family: number } | { ok: false; reason: string };

export class PolicyProxy {
  /** The most recent refused connections, oldest first. */
  readonly blocked: BlockedConnection[] = [];
  private readonly config: () => FetchConfig;
  private readonly resolve: Resolver;
  private readonly server: http.Server;
  private readonly sockets = new Set<Duplex>();

  constructor(options: PolicyProxyOptions = {}) {
    this.config = options.config ?? (() => fetchConfig());
    this.resolve = options.resolve ?? systemResolver;
    this.server = http.createServer((req, res) => void this.forward(req, res));
    this.server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) =>
      void this.tunnel(req, socket, head),
    );
    // WebSockets over plain http: no page text depends on them.
    this.server.on("upgrade", (_req, socket: Duplex) => socket.destroy());
    this.server.on("connection", (socket: net.Socket) => this.track(socket));
    this.server.on("clientError", (_err, socket: Duplex) => socket.destroy());
  }

  /** Starts listening on 127.0.0.1 and resolves to the proxy's URL, for the browser's proxy setting. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.server.unref();
    const { port } = this.server.address() as net.AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Stops listening and cuts every open connection. */
  close(): void {
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  private block(host: string, reason: string): void {
    this.blocked.push({ host, reason });
    if (this.blocked.length > MAX_BLOCKED) this.blocked.shift();
  }

  /** The fetch policy for a connection to `url`'s host: checkUrl, then every DNS answer. */
  private async check(url: URL): Promise<Check> {
    const config = this.config();
    // The host and port only: a tunnel shows nothing more, and headless.ts checks the page's paths.
    const origin = new URL(`${url.protocol}//${url.host}/`);
    const policy = checkUrl(origin, config);
    if (!policy.ok) return { ok: false, reason: policy.reason };
    const resolution = await resolveChecked(origin, origin, config, this.resolve);
    if (!resolution.ok) return { ok: false, reason: resolution.reason };
    const [first] = resolution.addresses;
    return { ok: true, address: first.address, family: first.family };
  }

  /** A plain http request, sent on to a checked address. */
  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("not an http URL");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const check = await this.check(url).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    if (!check.ok) {
      this.block(url.host, check.reason);
      res.writeHead(403, { "Content-Type": "text/plain" }).end(`blocked by mnemos: ${check.reason}`);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(name)) headers[name] = value;
    }
    const upstream = http.request(
      {
        protocol: "http:",
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        agent: false,
        lookup: pinnedLookup([{ address: check.address, family: check.family }]),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
        answer.pipe(res);
        answer.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  /** CONNECT host:port (https and wss): a TCP tunnel to a checked address. */
  private async tunnel(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    this.track(socket);
    let url: URL;
    try {
      url = new URL(`https://${req.url ?? ""}/`);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const check = await this.check(url).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    if (!check.ok) {
      this.block(url.host, check.reason);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (socket.destroyed) return;
    const upstream = net.connect({ host: check.address, port: Number(url.port || 443) });
    this.track(upstream);
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!connected && !socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  }
}
