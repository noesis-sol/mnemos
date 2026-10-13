/**
 * The worker thread behind extract.ts's Extractor: runs extractPage on each
 * page it is sent, one at a time, off the server's event loop.
 */

import { parentPort } from "node:worker_threads";
import { extractPage, type ExtractRequest, type ExtractResponse } from "./extract.js";

parentPort?.on("message", ({ id, html, url }: ExtractRequest) => {
  let response: ExtractResponse;
  try {
    response = { id, result: extractPage(html, url) };
  } catch (err) {
    response = { id, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort?.postMessage(response);
});
