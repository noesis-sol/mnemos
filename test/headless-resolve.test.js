// Finding the headless browser (dist/headless.js resolveBrowser), with an
// injected file system, environment, platform and home directory: each step
// of the order (MNEMOS_BROWSER, Playwright's channels chrome, chrome-beta,
// chrome-dev, chrome-canary and msedge, then Chromium and Brave where they
// install), MNEMOS_BROWSER=0 and a MNEMOS_BROWSER naming no file, Windows
// install prefixes, and nothing found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBrowser } from "../dist/headless.js";

const MAC = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "chrome-beta": "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "chrome-dev": "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
  "chrome-canary": "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
};
const ORDER = Object.keys(MAC);

/** resolveBrowser on a machine where exactly `files` exist, recording every path it looked at. */
function resolveWith(files, { env = {}, platform = "darwin", homedir = "/Users/u" } = {}) {
  const present = new Set(files);
  const looked = [];
  const result = resolveBrowser({
    env,
    platform,
    homedir,
    exists: (file) => {
      looked.push(file);
      return present.has(file);
    },
  });
  return { result, looked };
}

test("resolveBrowser: MNEMOS_BROWSER comes first, whatever else is installed", () => {
  const custom = "/opt/thorium/thorium";
  const { result } = resolveWith([custom, ...Object.values(MAC)], { env: { MNEMOS_BROWSER: ` ${custom} ` } });
  assert.deepEqual(result, { ok: true, executablePath: custom, source: "MNEMOS_BROWSER" });
});

test("resolveBrowser: each step of the order wins over the ones after it", () => {
  for (let i = 0; i < ORDER.length; i++) {
    const installed = ORDER.slice(i).map((name) => MAC[name]);
    const { result } = resolveWith(installed);
    assert.deepEqual(result, { ok: true, executablePath: MAC[ORDER[i]], source: ORDER[i] }, ORDER[i]);
  }
});

test("resolveBrowser: the channels are tried in Playwright's order, then Chromium and Brave", () => {
  const { result, looked } = resolveWith([]);
  assert.equal(result.ok, false);
  const order = ORDER.map((name) => looked.indexOf(MAC[name]));
  assert.ok(order.every((at) => at >= 0), "every known path is looked at");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in order");
});

test("resolveBrowser: nothing found", () => {
  const { result } = resolveWith(["/usr/bin/firefox"]);
  assert.deepEqual(result, { ok: false, why: "none", reason: "no Chromium-based browser found" });
});

test("resolveBrowser: MNEMOS_BROWSER=0 turns rendering off, even with a browser installed", () => {
  const { result, looked } = resolveWith([MAC.chrome], { env: { MNEMOS_BROWSER: "0" } });
  assert.equal(result.ok, false);
  assert.equal(result.why, "off");
  assert.deepEqual(looked, []);
});

test("resolveBrowser: a MNEMOS_BROWSER naming no file is an error, not a reason to pick another", () => {
  const { result } = resolveWith([MAC.chrome], { env: { MNEMOS_BROWSER: "/nowhere/chrome" } });
  assert.deepEqual(result, { ok: false, why: "missing", reason: "MNEMOS_BROWSER: no browser at /nowhere/chrome" });
});

test("resolveBrowser: an empty MNEMOS_BROWSER is not set", () => {
  const { result } = resolveWith([MAC.chrome], { env: { MNEMOS_BROWSER: "  " } });
  assert.equal(result.source, "chrome");
});

test("resolveBrowser: Chromium and Brave in the home directory's Applications on macOS", () => {
  const brave = "/Users/u/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  assert.deepEqual(resolveWith([brave]).result, { ok: true, executablePath: brave, source: "brave" });
});

test("resolveBrowser: Linux paths, channels before Chromium before Brave", () => {
  const linux = (files) => resolveWith(files, { platform: "linux", homedir: "/home/u" }).result;
  assert.equal(linux(["/opt/google/chrome/chrome", "/usr/bin/chromium"]).source, "chrome");
  assert.equal(linux(["/opt/microsoft/msedge/msedge", "/usr/bin/chromium"]).source, "msedge");
  assert.deepEqual(linux(["/snap/bin/chromium", "/usr/bin/brave-browser"]), {
    ok: true,
    executablePath: "/snap/bin/chromium",
    source: "chromium",
  });
  assert.equal(linux(["/opt/brave.com/brave/brave"]).source, "brave");
  assert.equal(linux([]).ok, false);
});

test("resolveBrowser: Windows looks under LOCALAPPDATA, then the Program Files folders", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  };
  const windows = (files) => resolveWith(files, { env, platform: "win32", homedir: "C:\\Users\\u" });
  const machineChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const userChrome = "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(windows([machineChrome]).result.executablePath, machineChrome);
  assert.equal(windows([machineChrome, userChrome]).result.executablePath, userChrome);
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.deepEqual(windows([edge]).result, { ok: true, executablePath: edge, source: "msedge" });
  const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
  assert.deepEqual(windows([brave]).result, { ok: true, executablePath: brave, source: "brave" });
  const canary = "C:\\Users\\u\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe";
  assert.equal(windows([canary, brave]).result.source, "chrome-canary");
});

test("resolveBrowser: Windows with only HOMEDRIVE set", () => {
  const chrome = "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const { result } = resolveWith([chrome], { env: { HOMEDRIVE: "D:" }, platform: "win32" });
  assert.equal(result.executablePath, chrome);
});
