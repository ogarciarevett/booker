import { constants } from "node:os";

/**
 * The exit code a launcher reports for its child: the child's own code, or 128 plus the signal
 * number when a signal killed it (what a shell reports), so a killed Next.js never looks like a
 * success.
 */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return 1;
}
