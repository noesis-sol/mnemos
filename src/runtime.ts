/**
 * The embedding runtime: @huggingface/transformers, installed on first use.
 *
 * It is not a dependency of mnemos-mcp. With onnxruntime-node, onnxruntime-web
 * and sharp it adds about 488 MB, which made a cold `npx -y mnemos-mcp` (empty
 * npm cache) take about 34 s to answer initialize on a Mac, past MCP clients'
 * start timeouts (Claude Code's MCP_TIMEOUT is 30 s), against about 4 s
 * without it. So the first time the embedder needs it, which is after the
 * handshake, mnemos looks for it beside itself (a development checkout, or a
 * user who installed it there), then in <cache dir>/runtime, and only then
 * runs npm to install it there.
 *
 * npm installs into a temporary folder in <cache dir>/runtime, which is then
 * renamed into place: a runtime folder is complete or absent, and two mnemos
 * processes installing at once each finish their own and keep whichever came
 * first. Install scripts are skipped: onnxruntime-node ships its CPU binaries
 * in the package and its postinstall would only download the CUDA provider on
 * Linux x64, and sharp's binaries come as optional packages.
 *
 * Each runtime folder is named after its version, so a new TRANSFORMERS_VERSION
 * installs beside the old one. Another mnemos on this machine (an older npx
 * cache entry) may still use that one, so it is not removed on install: each
 * load touches a marker in the folder it loads from, and removes the other
 * versions' folders whose marker is UNUSED_RUNTIME_MS old.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cacheDir } from "./index-store.js";

export const TRANSFORMERS = "@huggingface/transformers";
/** The version installed. package.json's devDependency, which the tests and the model e2e use, matches it. */
export const TRANSFORMERS_VERSION = "4.3.1";
/** npm is stopped after this, and the install counts as failed. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** A temporary install folder this old is from a process that died: removed by the next install. */
const STALE_INSTALL_MS = 2 * INSTALL_TIMEOUT_MS;
const TEMP_PREFIX = ".install-";
/** The module in a runtime folder that re-exports the library; written with it, so it marks a complete one. */
const LOADER = "load.mjs";
/** The file in a runtime folder whose mtime is when a mnemos last loaded it. */
export const LAST_USED = "last-used";
/** Another version's runtime not loaded for this long is removed. */
export const UNUSED_RUNTIME_MS = 30 * 24 * 60 * 60_000;
const FOLDER_PREFIX = "transformers-";

/** npm could not install the runtime: a network or registry failure, worth trying again later. */
export class RuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeInstallError";
  }
}

/** The runtime folder in mnemos's cache directory. */
export function runtimeDir(dir: string = cacheDir()): string {
  return path.join(dir, "runtime");
}

/** The folder one dependency spec installs into: "transformers-4.3.1". */
export function runtimeFolder(spec: string): string {
  return `${FOLDER_PREFIX}${spec.replace(/[^\w.-]+/g, "_").slice(-80)}`;
}

/** How to run npm: the npm that runs mnemos (npx), the one beside node, or npm on the PATH. */
export function npmCommand(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): { command: string; args: string[]; shell: boolean } {
  const p = platform === "win32" ? path.win32 : path.posix;
  const candidates: string[] = [];
  const execpath = env.npm_execpath;
  if (execpath && /np[mx]-cli\.c?js$/.test(execpath)) {
    candidates.push(p.join(p.dirname(execpath), "npm-cli.js"));
  }
  const bin = p.dirname(execPath);
  candidates.push(
    platform === "win32"
      ? p.join(bin, "node_modules", "npm", "bin", "npm-cli.js")
      : p.join(p.dirname(bin), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  const cli = candidates.find((file) => exists(file));
  if (cli) return { command: execPath, args: [cli], shell: false };
  // npm.cmd can only be spawned through a shell; the arguments are constant flags.
  return platform === "win32" ? { command: "npm.cmd", args: [], shell: true } : { command: "npm", args: [], shell: false };
}

/** npm's own config from the environment would redirect the install: npx sets the prefix to the user's directory. */
const DROPPED_NPM_CONFIG = new Set(["prefix", "local_prefix", "global", "location", "call", "package", "yes", "save"]);

/**
 * The environment npm runs in: mnemos's, without what npx sets for the
 * command it runs (npm_package_json, npm_lifecycle_*, npm_config_local_prefix…),
 * keeping the user's npm config (registry, proxy, cache).
 */
export function npmEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("npm_")) {
      if (!lower.startsWith("npm_config_")) continue;
      if (DROPPED_NPM_CONFIG.has(lower.slice("npm_config_".length))) continue;
    }
    out[key] = value;
  }
  return out;
}

export interface LoadTransformersOptions {
  /** mnemos's cache directory; the runtime goes into its runtime folder. Defaults to cacheDir(). */
  dir?: string;
  /** What npm installs as @huggingface/transformers: a version, or for tests a file: path. */
  spec?: string;
  /** false: never run npm (MNEMOS_INSTALL_RUNTIME=0); a missing runtime is then an import failure. */
  install?: boolean;
  /** Called once npm starts. */
  onInstall?: () => void;
  /** The import of the library beside mnemos; tests pass one that fails. */
  importBeside?: () => Promise<unknown>;
  /** The environment npm and npmCommand see. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * The library: from beside mnemos, else from <cache dir>/runtime, installing
 * it there first unless `install` is false; a load from there marks its folder
 * used and removes other versions' runtimes unused for UNUSED_RUNTIME_MS.
 * Rejects with RuntimeInstallError when npm fails, and with the import's error
 * when the library is missing and not to be installed.
 */
export async function loadTransformers(options: LoadTransformersOptions = {}): Promise<unknown> {
  const importBeside = options.importBeside ?? (() => import(TRANSFORMERS));
  let besideError: unknown;
  try {
    return await importBeside();
  } catch (err) {
    besideError = err;
  }
  const root = runtimeDir(options.dir);
  const folder = path.join(root, runtimeFolder(options.spec ?? TRANSFORMERS_VERSION));
  if (!fs.existsSync(path.join(folder, LOADER))) {
    if (options.install === false) throw besideError;
    options.onInstall?.();
    try {
      await installRuntime(root, folder, options);
    } catch (err) {
      throw err instanceof RuntimeInstallError ? err : new RuntimeInstallError(`the runtime could not be installed: ${message(err)}`);
    }
  }
  markUsed(folder);
  removeStale(root);
  await removeUnused(root, path.basename(folder));
  return import(pathToFileURL(path.join(folder, LOADER)).href);
}

async function installRuntime(root: string, folder: string, options: LoadTransformersOptions): Promise<void> {
  fs.mkdirSync(root, { recursive: true });
  removeStale(root);
  const temp = fs.mkdtempSync(path.join(root, TEMP_PREFIX));
  try {
    const manifest = {
      name: "mnemos-runtime",
      private: true,
      description: "mnemos's embedding runtime, installed on first use; safe to delete",
      dependencies: { [TRANSFORMERS]: options.spec ?? TRANSFORMERS_VERSION },
    };
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(temp, LOADER), `export * from ${JSON.stringify(TRANSFORMERS)};\n`);
    await runNpm(temp, options.env ?? process.env, options.timeoutMs ?? INSTALL_TIMEOUT_MS);
    // npm links a file: spec without checking it, and exits 0.
    if (!fs.existsSync(path.join(temp, "node_modules", ...TRANSFORMERS.split("/"), "package.json"))) {
      throw new RuntimeInstallError(`npm install finished without installing ${TRANSFORMERS}`);
    }
    try {
      fs.renameSync(temp, folder);
    } catch (err) {
      // Another mnemos finished first: use its runtime, drop this one.
      if (!fs.existsSync(path.join(folder, LOADER))) {
        throw new RuntimeInstallError(`${temp} could not be moved to ${folder}: ${message(err)}`);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Removes installs a dead process left behind, and the folders removeUnused
 * renamed but did not finish removing. Never throws.
 */
function removeStale(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(root, entry.name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > STALE_INSTALL_MS) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}

/** Sets the folder's last use to now. Never throws: a read-only cache only loses the pruning. */
function markUsed(folder: string): void {
  const marker = path.join(folder, LAST_USED);
  try {
    const now = new Date();
    fs.utimesSync(marker, now, now);
  } catch {
    try {
      fs.writeFileSync(marker, "");
    } catch {
      // read-only
    }
  }
}

/**
 * Removes the runtime folders other than `keep` last used UNUSED_RUNTIME_MS
 * ago: by their marker, or for one installed before markers by its loader.
 * Each is first renamed to a temporary folder, so a mnemos loading it finds it
 * whole or absent; one interrupted removal is finished by removeStale. Never
 * throws.
 */
async function removeUnused(root: string, keep: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FOLDER_PREFIX) || entry.name === keep) continue;
    const full = path.join(root, entry.name);
    try {
      if (Date.now() - lastUsed(full) < UNUSED_RUNTIME_MS) continue;
      const doomed = path.join(root, `${TEMP_PREFIX}${entry.name}-${process.pid}-${Date.now()}`);
      fs.renameSync(full, doomed);
      // The folder keeps its mtime, so removeStale finishes it should this stop.
      await fs.promises.rm(doomed, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // in use (Windows), or another mnemos removed it first
    }
  }
}

/** When a runtime folder was last loaded: its marker's mtime, else its loader's, else its own. */
function lastUsed(folder: string): number {
  for (const file of [LAST_USED, LOADER]) {
    try {
      return fs.statSync(path.join(folder, file)).mtimeMs;
    } catch {
      // try the next
    }
  }
  return fs.statSync(folder).mtimeMs;
}

/** Stops each npm install running; set by stopInstalls(). */
const runningInstalls = new Set<() => void>();
let installsStopped = false;

/**
 * Shutdown: stops the npm installs running, which then reject with
 * RuntimeInstallError, and has every later one reject before it starts, so
 * npm does not go on downloading for a client that is gone.
 */
export function stopInstalls(): void {
  installsStopped = true;
  for (const kill of runningInstalls) kill();
}

/** Runs `npm install` in `cwd`, its output kept from stdout (the MCP channel). */
function runNpm(cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const npm = npmCommand(env);
  const args = [...npm.args, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error"];
  return new Promise((resolve, reject) => {
    if (installsStopped) return reject(new RuntimeInstallError("mnemos is shutting down"));
    let output = "";
    const child = spawn(npm.command, args, { cwd, env: npmEnv(env), shell: npm.shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    // npm would go on writing into the cache directory after mnemos exits.
    const kill = () => child.kill();
    process.once("exit", kill);
    runningInstalls.add(kill);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("exit", kill);
      runningInstalls.delete(kill);
      if (err) reject(err);
      else resolve();
    };
    child.on("error", (err) => done(new RuntimeInstallError(`npm could not be started: ${err.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) return done();
      const why = timedOut ? `npm did not finish within ${timeoutMs / 1000} s` : `npm install failed (${signal ?? `exit code ${code}`})`;
      const tail = output.trim().split("\n").slice(-5).join("\n");
      done(new RuntimeInstallError(tail ? `${why}: ${tail}` : why));
    });
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
