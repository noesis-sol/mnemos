// The Windows ProgIds of Firefox's forks (src/default-browser.ts): LibreWolf's
// own LibreWolfHTM, and Zen's and Floorp's, which are Firefox's own
// (FirefoxURL-<hash>) and told apart by the executable the ProgId's
// shell\open\command runs, read with reg query.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as db from "../dist/default-browser.js";

beforeEach(() => db.resetDefaultBrowser());
afterEach(() => db.resetDefaultBrowser());

const ASSOCIATIONS = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https";

/** reg query's output for one value of `key`. */
const regOutput = (key, name, value) => `\r\n${key}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`;

/**
 * A run() for a machine whose https UserChoice is `progId` and whose ProgId
 * opens `command` (no command: the ProgId has no shell\open\command key).
 */
function windows(progId, command) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, "reg");
    const key = args[1];
    if (key === `${ASSOCIATIONS}\\UserChoice`) return regOutput(key, "ProgId", progId);
    if (key === `HKCR\\${progId}\\shell\\open\\command` && command !== undefined) {
      return regOutput(`HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`, "(Default)", command);
    }
    throw new Error("ERROR: The system was unable to find the specified registry key or value.");
  };
  return { run, calls };
}

const resolve = (run) =>
  db.resolveDefaultBrowser({ platform: "win32", run, installed: () => assert.fail("the fallback is not consulted") });

test("identify: LibreWolf's installer registers LibreWolfHTM", () => {
  assert.deepEqual(db.identifyBrowser("win32", "LibreWolfHTM"), { browser: "librewolf" });
});

test("identify: Firefox's ProgIds name the browser by the executable they open", () => {
  const cases = {
    '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"': "firefox",
    '"C:\\Program Files\\Zen Browser\\zen.exe" -osint -url "%1"': "zen",
    '"C:\\Program Files\\Ablaze Floorp\\floorp.exe" -osint -url "%1"': "floorp",
    '"C:\\Program Files\\LibreWolf\\LibreWolf.exe" -osint -url "%1"': "librewolf",
    "C:\\PROGRA~1\\Waterfox\\waterfox.exe -osint -url \"%1\"": "waterfox",
  };
  for (const [command, browser] of Object.entries(cases)) {
    for (const id of ["FirefoxURL-308046B0AF4A39CB", "FirefoxHTML-308046B0AF4A39CB"]) {
      assert.deepEqual(db.identifyBrowser("win32", id, command), { browser }, `${id} ${command}`);
    }
  }
  // Without the command, Firefox's ProgId is Firefox.
  assert.deepEqual(db.identifyBrowser("win32", "FirefoxURL-308046B0AF4A39CB"), { browser: "firefox" });
});

test("identify: another fork registering Firefox's ProgIds is unknown, not Firefox", () => {
  assert.deepEqual(
    db.identifyBrowser("win32", "FirefoxURL-ABCDEF0123456789", '"C:\\Program Files\\Mercury\\mercury.exe" -osint -url "%1"'),
    { unknown: "FirefoxURL-ABCDEF0123456789 (mercury.exe)" },
  );
});

test("identify: the command does not change a ProgId that is not Firefox's", () => {
  const zen = '"C:\\Program Files\\Zen Browser\\zen.exe" -osint -url "%1"';
  assert.deepEqual(db.identifyBrowser("win32", "ChromeHTML", zen), { browser: "chrome" });
  assert.deepEqual(db.identifyBrowser("win32", "WaterfoxURL-ABC", zen), { browser: "waterfox" });
});

test("resolve: Zen as the default browser, from its FirefoxURL ProgId's command", () => {
  const progId = "FirefoxURL-1F2E3D4C5B6A7980";
  const { run, calls } = windows(progId, '"C:\\Program Files\\Zen Browser\\zen.exe" -osint -url "%1"');
  assert.deepEqual(resolve(run), {
    browser: "zen",
    detected: { id: progId, source: "registry (UserChoice)" },
  });
  assert.deepEqual(calls.at(-1), ["reg", "query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"]);
});

test("resolve: Floorp as the default browser, with a localized default value name", () => {
  const progId = "FirefoxURL-0A1B2C3D4E5F6071";
  const command = '"C:\\Program Files\\Ablaze Floorp\\floorp.exe" -osint -url "%1"';
  const run = (cmd, args) =>
    args[1] === `HKCR\\${progId}\\shell\\open\\command`
      ? `\r\nHKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command\r\n    (Standard)    REG_SZ    ${command}\r\n\r\n`
      : windows(progId).run(cmd, args);
  assert.equal(resolve(run).browser, "floorp");
});

test("resolve: LibreWolf as the default browser, by its ProgId alone", () => {
  const { run, calls } = windows("LibreWolfHTM");
  assert.equal(resolve(run).browser, "librewolf");
  assert.ok(!calls.some((c) => c[2].startsWith("HKCR\\")), "no command lookup for a ProgId of its own");
});

test("resolve: Firefox's ProgId without a readable command is Firefox", () => {
  assert.equal(resolve(windows("FirefoxURL-308046B0AF4A39CB").run).browser, "firefox");
});

test("resolve: an unknown fork registering Firefox's ProgIds is an error naming its executable", () => {
  const { run } = windows("FirefoxURL-ABCDEF0123456789", '"C:\\Program Files\\Mercury\\mercury.exe" -osint -url "%1"');
  assert.throws(
    () => db.resolveDefaultBrowser({ platform: "win32", run, installed: () => ["firefox"] }),
    (e) => /"FirefoxURL-ABCDEF0123456789 \(mercury\.exe\)"/.test(e.message) && /does not know how to read/.test(e.message),
  );
});
