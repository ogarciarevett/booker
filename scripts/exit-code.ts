import { constants } from "node:os";

/**
 * The exit code a launcher reports for its child: the child's own code, or 128 plus the signal
 * number when a signal killed it (what a shell reports), so a killed child never looks like a
 * success. (The dashboard keeps its own copy: apps/ packages do not import the root.)
 */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return 1;
}
