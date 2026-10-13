// The headless browser's policy proxy (dist/policy-proxy.js), driven as a
// browser would drive it: plain http requests in absolute form and CONNECT
// tunnels. Allowed hosts are reached at the address that was checked; a
// local name, a private IP literal or a name resolving to a private address
// is refused before any connection, and recorded.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { PolicyProxy } from "../dist/policy-proxy.js";
import { fetchConfig } from "../dist/fetch.js";

let site;
let hits = [];
let proxy;
let proxyPort;

before(async () => {
  site = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    res.writeHead(200, { "Content-Type": "text/plain", "X-Seen-Proxy-Header": String(req.headers["proxy-connection"] ?? "") });
    res.end(`hello from ${req.url}`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = site.address().port;
  // site.test resolves to the fixture and is allowed; evil.test resolves to a private address.
  const resolve = async (host) => {
    if (host === "site.test") return [{ address: "127.0.0.1", family: 4 }];
    if (host === "evil.test") return [{ address: "10.0.0.7", family: 4 }];
    if (host === "mixed.test") return [{ address: "93.184.215.14", family: 4 }, { address: "192.168.1.1", family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  };
  proxy = new PolicyProxy({ config: () => fetchConfig({ MNEMOS_FETCH_ALLOW_HOSTS: `site.test:${port}` }), resolve });
  proxyPort = Number(new URL(await proxy.listen()).port);
});

after(() => {
  proxy.close();
  site.closeAllConnections();
  site.close();
});

/** A plain http request for `url` through the proxy. */
function viaProxy(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: url, headers: { Host: target.host, "Proxy-Connection": "keep-alive" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** CONNECT host:port through the proxy; resolves to the status line and, if tunnelled, the socket. */
function connect(authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let data = "";
    socket.on("error", reject);
    socket.on("data", function onData(chunk) {
      data += chunk.toString("latin1");
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ status: data.split("\r\n")[0], socket });
    });
    socket.on("end", () => resolve({ status: data.split("\r\n")[0], socket }));
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

test("PolicyProxy: an allowed host is reached at its checked address, without the proxy's headers", async () => {
  const port = site.address().port;
  const res = await viaProxy(`http://site.test:${port}/page?x=1`);
  assert.equal(res.status, 200);
  assert.equal(res.body, "hello from /page?x=1");
  assert.equal(res.headers["x-seen-proxy-header"], "", "Proxy-Connection is not passed on");
  assert.ok(hits.includes(`site.test:${port}/page?x=1`));
});

test("PolicyProxy: local names, private literals and names resolving to private addresses are refused", async () => {
  const port = site.address().port;
  const before = hits.length;
  for (const [url, reason] of [
    [`http://localhost:${port}/secret`, "private-address"],
    [`http://127.0.0.1:${port}/secret`, "private-address"],
    [`http://evil.test:${port}/secret`, "private-address"],
    [`http://mixed.test:${port}/secret`, "private-address"],
    [`http://nowhere.test/secret`, "dns"],
  ]) {
    const res = await viaProxy(url);
    assert.equal(res.status, 403, url);
    assert.match(res.body, new RegExp(`blocked by mnemos: ${reason}`), url);
    assert.deepEqual(proxy.blocked.at(-1), { host: new URL(url).host, reason }, url);
  }
  assert.equal(hits.length, before, "nothing reached the site");
});

test("PolicyProxy: CONNECT tunnels to an allowed host, and is refused for a private one", async () => {
  const port = site.address().port;
  const tunnel = await connect(`site.test:${port}`);
  assert.equal(tunnel.status, "HTTP/1.1 200 Connection Established");
  const answer = await new Promise((resolve) => {
    let body = "";
    tunnel.socket.on("data", (chunk) => (body += chunk));
    tunnel.socket.on("close", () => resolve(body));
    tunnel.socket.write(`GET /tunnelled HTTP/1.1\r\nHost: site.test:${port}\r\nConnection: close\r\n\r\n`);
  });
  assert.match(answer, /hello from \/tunnelled/);

  const before = hits.length;
  for (const authority of ["evil.test:443", "localhost:443", "[::1]:443", "192.168.0.1:443"]) {
    const refused = await connect(authority);
    assert.equal(refused.status, "HTTP/1.1 403 Forbidden", authority);
    refused.socket.destroy();
  }
  assert.equal(hits.length, before);
  assert.deepEqual(proxy.blocked.at(-1), { host: "192.168.0.1", reason: "private-address" });
});
