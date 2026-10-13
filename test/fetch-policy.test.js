// The page fetch policy, rule by rule, without any network: schemes, private
// and local addresses (IPv4, IPv6, IPv4-mapped), token-like URLs, skipped
// domains and folders, the allow list, and the request headers. Network-free
// safeFetch cases (injected resolvers) are here too; the ones that need a
// listening server are in fetch-wrapper.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as f from "../dist/fetch.js";

const { SEP } = await import("../dist/lib.js");

const noConfig = f.fetchConfig({});

/** A resolver that answers from a table and fails for anything else. */
const resolver = (table) => async (host) => {
  if (!(host in table)) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

// --- schemes -----------------------------------------------------------------

for (const url of [
  "file:///etc/passwd",
  "chrome://settings",
  "chrome-extension://abc/page.html",
  "javascript:alert(1)",
  "data:text/html,<p>hi</p>",
  "about:blank",
  "ftp://ftp.example.com/file",
  "mailto:someone@example.com",
]) {
  test(`checkUrl: ${url.split(":")[0]}: is skipped with reason "scheme"`, () => {
    assert.deepEqual(f.checkUrl(url, noConfig), { ok: false, reason: "scheme" });
  });
}

test("checkUrl: http and https pass, an unparseable URL is invalid-url", () => {
  assert.equal(f.checkUrl("http://example.com/", noConfig).ok, true);
  assert.equal(f.checkUrl("https://example.com/a?q=1", noConfig).ok, true);
  assert.deepEqual(f.checkUrl("not a url", noConfig), { ok: false, reason: "invalid-url" });
});

// --- addresses ---------------------------------------------------------------

const ADDRESSES = [
  // [address, blocked]
  ["127.0.0.1", true],
  ["127.255.255.254", true],
  ["0.0.0.0", true],
  ["10.0.0.1", true],
  ["10.255.255.255", true],
  ["172.15.255.255", false],
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["172.32.0.1", false],
  ["192.168.1.1", true],
  ["192.169.0.1", false],
  ["169.254.169.254", true],
  ["100.64.0.1", true],
  ["8.8.8.8", false],
  ["93.184.216.34", false],
  ["::", true],
  ["::1", true],
  ["0:0:0:0:0:0:0:1", true],
  ["fc00::1", true],
  ["fd12:3456:789a::1", true],
  ["fe80::1", true],
  ["fe80::1%en0", true],
  ["febf::1", true],
  ["fec0::1", true],
  ["2606:4700:4700::1111", false],
  ["2001:4860:4860::8888", false],
  // IPv4-mapped, in both spellings, and the other IPv4-in-IPv6 forms
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:10.1.2.3", true],
  ["::ffff:192.168.0.1", true],
  ["::ffff:8.8.8.8", false],
  ["::127.0.0.1", true],
  ["64:ff9b::7f00:1", true],
  ["64:ff9b::808:808", false],
  ["2002:c0a8:101::1", true],
  ["2002:808:808::1", false],
  ["not-an-address", true],
];

for (const [address, blocked] of ADDRESSES) {
  test(`isBlockedAddress: ${address} is ${blocked ? "blocked" : "allowed"}`, () => {
    assert.equal(f.isBlockedAddress(address), blocked);
  });
}

for (const url of [
  "http://127.0.0.1/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f.0.0.1/",
  "https://10.0.0.5:8443/admin",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://0.0.0.0/",
  "http://[::1]/",
  "http://[::]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:a00:1]/",
  "http://[fe80::1]/",
  "http://[fd00::1]/",
  "http://localhost/",
  "http://localhost.:3000/",
  "http://LOCALHOST/",
  "http://app.localhost/",
  "http://printer.local/",
  "http://nas.LOCAL./",
]) {
  test(`checkUrl: ${url} is skipped with reason "private-address"`, () => {
    assert.deepEqual(f.checkUrl(url, noConfig), { ok: false, reason: "private-address" });
  });
}

test("checkUrl: public literals and names that only look local pass", () => {
  for (const url of [
    "http://8.8.8.8/",
    "http://[2606:4700:4700::1111]/",
    "https://localhost.example.com/",
    "https://local.example.com/",
    "https://mylocal/",
  ]) {
    assert.equal(f.checkUrl(url, noConfig).ok, true, url);
  }
});

// --- token-like URLs ---------------------------------------------------------

const TOKEN_LIKE = [
  "https://example.com/?token=abc",
  "https://example.com/?TOKEN=abc",
  "https://example.com/?access_token=abc",
  "https://example.com/?id_token=abc",
  "https://example.com/?key=abc",
  "https://example.com/?apikey=abc",
  "https://example.com/?api_key=abc",
  "https://example.com/?apiKey=abc",
  "https://example.com/?API-KEY=abc",
  "https://example.com/?sig=abc",
  "https://example.com/?X-Amz-Signature=abc",
  "https://example.com/?signature=abc",
  "https://example.com/?code=abc",
  "https://example.com/?auth=abc",
  "https://example.com/?session=abc",
  "https://example.com/?sessionId=abc",
  "https://example.com/?sid=abc",
  "https://example.com/?otp=123456",
  "https://example.com/?password=hunter2",
  "https://example.com/?client_secret=abc",
  "https://example.com/?a=1&Secret=2",
  "https://example.com/unsubscribe",
  "https://example.com/email/Unsubscribe?u=1",
  "https://example.com/account/logout",
  "https://example.com/signout",
  "https://example.com/sign-out/",
  "https://example.com/post/42/delete",
  "https://example.com/confirm-email/xyz",
  "https://example.com/verify",
  "https://example.com/auth/magic-link/xyz",
  "https://example.com/activate/xyz",
  "https://example.com/%55nsubscribe",
  "https://user:pass@example.com/",
];

for (const url of TOKEN_LIKE) {
  test(`checkUrl: ${url} is skipped with reason "token-like"`, () => {
    assert.deepEqual(f.checkUrl(url, noConfig), { ok: false, reason: "token-like" });
  });
}

test("checkUrl: ordinary query parameters and paths are not token-like", () => {
  for (const url of [
    "https://example.com/?q=tokens",
    "https://example.com/?keyword=ai",
    "https://example.com/?codec=h264",
    "https://example.com/?v=dQw4w9WgXcQ&t=42",
    "https://example.com/?page=2&sort=asc",
    "https://example.com/?monkey=1",
    "https://example.com/docs/api-keys",
    "https://example.com/blog/session-types",
  ]) {
    assert.equal(f.checkUrl(url, noConfig).ok, true, url);
  }
});

// --- skipped domains and folders ----------------------------------------------

test("MNEMOS_SKIP_DOMAINS: a domain matches itself and its subdomains only", () => {
  const config = f.fetchConfig({ MNEMOS_SKIP_DOMAINS: " Example.com, .ads.net,*.tracker.io,, ελληνικά.gr " });
  const cases = [
    ["https://example.com/", "skip-domain"],
    ["https://www.example.com/a", "skip-domain"],
    ["https://deep.sub.EXAMPLE.com./", "skip-domain"],
    ["https://notexample.com/", null],
    ["https://example.com.evil.net/", null],
    ["https://ads.net/", "skip-domain"],
    ["https://x.ads.net/", "skip-domain"],
    ["https://tracker.io/", "skip-domain"],
    ["https://www.ελληνικά.gr/", "skip-domain"],
    ["https://other.gr/", null],
  ];
  for (const [url, reason] of cases) {
    const r = f.checkUrl(url, config);
    assert.deepEqual(r.ok ? null : r.reason, reason, url);
  }
});

test("MNEMOS_SKIP_FOLDERS: whole-word folder match, like folderMatches; blanks ignored", () => {
  const config = f.fetchConfig({ MNEMOS_SKIP_FOLDERS: "Private, , Bank Stuff" });
  const url = "https://example.com/";
  const cases = [
    [`Bookmarks Bar${SEP}Private`, "skip-folder"],
    [`Bookmarks Bar${SEP}private${SEP}Deep`, "skip-folder"],
    [`Bookmarks Bar${SEP}Privateer`, null],
    [`Other Bookmarks${SEP}My Bank Stuff`, "skip-folder"],
    [`Other Bookmarks${SEP}Work`, null],
  ];
  for (const [folder, reason] of cases) {
    const r = f.checkUrl(url, config, folder);
    assert.deepEqual(r.ok ? null : r.reason, reason, folder);
  }
  // Without a folder (a redirect hop), the folder rule does not apply.
  assert.equal(f.checkUrl(url, config).ok, true);
  assert.equal(f.isSkippedFolder(`Bookmarks Bar${SEP}Private`, config), true);
  // An empty variable skips nothing, even though folderMatches("", x) is true.
  assert.equal(f.isSkippedFolder("Anything", f.fetchConfig({ MNEMOS_SKIP_FOLDERS: " , " })), false);
});

// --- the allow list -----------------------------------------------------------

test("MNEMOS_FETCH_ALLOW_HOSTS: parses host, host:port and IPv6 forms", () => {
  const config = f.fetchConfig({
    MNEMOS_FETCH_ALLOW_HOSTS: "127.0.0.1:8080, Intranet.Corp ,[::1]:9000,::1,[fd00::1]",
  });
  assert.deepEqual(config.allowHosts, [
    { host: "127.0.0.1", port: "8080" },
    { host: "intranet.corp" },
    { host: "::1", port: "9000" },
    { host: "::1" },
    { host: "fd00::1", port: undefined },
  ]);
});

test("MNEMOS_FETCH_ALLOW_HOSTS: exempts the listed host (and port) from the private block", () => {
  const config = f.fetchConfig({ MNEMOS_FETCH_ALLOW_HOSTS: "127.0.0.1:8080,wiki.local,[::1]:9000" });
  const cases = [
    ["http://127.0.0.1:8080/", true],
    ["http://127.0.0.1:9090/", false],
    ["http://127.0.0.1/", false],
    ["http://wiki.local/", true],
    ["https://WIKI.local:8443/", true],
    ["http://other.local/", false],
    ["http://[::1]:9000/", true],
    ["http://[::1]:9001/", false],
  ];
  for (const [url, ok] of cases) assert.equal(f.checkUrl(url, config).ok, ok, url);
  // The allow list lifts only the address rule, not the others.
  assert.deepEqual(f.checkUrl("http://127.0.0.1:8080/?token=x", config), {
    ok: false,
    reason: "token-like",
  });
});

// --- headers ---------------------------------------------------------------------

test("USER_AGENT is a desktop Chrome string", () => {
  assert.match(f.USER_AGENT, /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
});

test("acceptLanguage: the system locale, its language, then English", () => {
  const cases = [
    ["en-US", "en-US,en;q=0.9"],
    ["el-GR", "el-GR,el;q=0.9,en;q=0.8"],
    ["de", "de,en;q=0.9"],
    ["en", "en"],
    ["de-DE-u-co-phonebk", "de-DE,de;q=0.9,en;q=0.8"],
    ["und", "en"],
    ["", "en"],
  ];
  for (const [locale, header] of cases) assert.equal(f.acceptLanguage(locale), header, locale);
  assert.match(f.acceptLanguage(), /(^|,)en(;q=0\.\d)?$/);
});

test("limits are the documented ones", () => {
  assert.equal(f.FETCH_TIMEOUT_MS, 15_000);
  assert.equal(f.MAX_RESPONSE_BYTES, 5 * 1024 * 1024);
  assert.equal(f.MAX_REDIRECTS, 5);
});

// --- safeFetch without a network: policy and resolution -----------------------

test("safeFetch: policy skips come back before any lookup", async () => {
  const resolve = async () => assert.fail("must not resolve");
  const config = f.fetchConfig({ MNEMOS_SKIP_DOMAINS: "example.com", MNEMOS_SKIP_FOLDERS: "Private" });
  assert.deepEqual(await f.safeFetch("javascript:void(0)", { config, resolve }), {
    status: "skipped",
    reason: "scheme",
    url: "javascript:void(0)",
  });
  assert.equal((await f.safeFetch("https://a.example.com/", { config, resolve })).reason, "skip-domain");
  assert.equal((await f.safeFetch("https://b.org/?token=1", { config, resolve })).reason, "token-like");
  assert.equal(
    (await f.safeFetch("https://b.org/", { config, resolve, folder: `Bookmarks Bar${SEP}Private` })).reason,
    "skip-folder",
  );
  assert.equal((await f.safeFetch("http://[::ffff:127.0.0.1]/", { config, resolve })).reason, "private-address");
});

test("safeFetch: a public name resolving to 127.0.0.1 is skipped as private-address", async () => {
  const r = await f.safeFetch("https://public.example/", {
    config: noConfig,
    resolve: resolver({ "public.example": ["127.0.0.1"] }),
  });
  assert.deepEqual(r, { status: "skipped", reason: "private-address", url: "https://public.example/" });
});

test("safeFetch: one private address among public ones is enough to skip", async () => {
  for (const addresses of [["93.184.216.34", "10.0.0.1"], ["2606:4700::1", "::ffff:192.168.1.1"], ["fe80::1"]]) {
    const r = await f.safeFetch("https://mixed.example/", {
      config: noConfig,
      resolve: resolver({ "mixed.example": addresses }),
    });
    assert.equal(r.reason, "private-address", addresses.join(","));
  }
});

test("safeFetch: the http:// upgrade is checked too, and a lookup failure is reason dns", async () => {
  const r = await f.safeFetch("http://rebind.example/", {
    config: noConfig,
    resolve: resolver({ "rebind.example": ["127.0.0.1"] }),
  });
  // Stopped on the https attempt; a policy stop never falls back to http.
  assert.deepEqual(r, { status: "skipped", reason: "private-address", url: "https://rebind.example/" });

  const missing = await f.safeFetch("https://nowhere.example/", { config: noConfig, resolve: resolver({}) });
  assert.equal(missing.status, "failed");
  assert.equal(missing.reason, "dns");
});
