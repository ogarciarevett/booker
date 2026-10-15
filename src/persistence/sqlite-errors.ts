import { LibsqlError } from "@libsql/client";

/** Bounds how long a caller retries an operation that keeps hitting SQLITE_BUSY. */
const MAX_BUSY_RETRIES = 50;

/**
 * Finds the underlying `LibsqlError`, unwrapping `.cause` since drizzle-orm
 * wraps the driver's error in its own `DrizzleQueryError`.
 */
function findLibsqlError(error: unknown): LibsqlError | undefined {
  if (error instanceof LibsqlError) return error;
  if (error instanceof Error && error.cause !== undefined) return findLibsqlError(error.cause);
  return undefined;
}

/** True for `error` being a `LibsqlError` (possibly wrapped) whose `code` is `sqliteCode`. */
function hasLibsqlCode(error: unknown, sqliteCode: string): boolean {
  return findLibsqlError(error)?.code === sqliteCode;
}

/**
 * True for a libsql "UNIQUE constraint failed" error whose message names
 * exactly `column` (e.g. "bookings.id"), distinguishing which constraint was
 * violated when a table has more than one unique index.
 */
export function isUniqueConstraintViolationOn(error: unknown, column: string): boolean {
  const libsqlError = findLibsqlError(error);
  return (
    libsqlError !== undefined &&
    libsqlError.code === "SQLITE_CONSTRAINT" &&
    libsqlError.message.includes(`UNIQUE constraint failed: ${column}`)
  );
}

/** True for a libsql "database is locked" error (a concurrent writer holds the file lock). */
export function isBusyError(error: unknown): boolean {
  return hasLibsqlCode(error, "SQLITE_BUSY");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Runs `operation`, retrying with a short linear backoff while it fails with
 * SQLITE_BUSY. The native busy-timeout is kept short (see `openDatabase` in
 * `database.ts`) because, observed directly under 20-way contention, its own
 * internal retry can stall for nearly the full timeout per attempt; retrying
 * here at the application level resolves the same contention in milliseconds.
 */
export async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === MAX_BUSY_RETRIES - 1;
      if (isBusyError(error) && !isLastAttempt) {
        await sleep(5 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error("withBusyRetry: exhausted attempts without returning or throwing");
}
