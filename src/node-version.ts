/**
 * The oldest Node mnemos runs on: 22.13 is the first release with node:sqlite
 * unflagged, which the index store and the Firefox reader need. Keep in step
 * with package.json's engines field.
 */
export const MIN_NODE = "22.13.0";

/** Whether `version` (as in process.versions.node, e.g. "20.17.0") is at least MIN_NODE. */
export function supportsNode(version: string): boolean {
  const have = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const need = MIN_NODE.split(".").map(Number);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    if (a !== need[i]) return a > need[i];
  }
  return true;
}
