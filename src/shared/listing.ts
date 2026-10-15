/** Throws a RangeError unless `limit` is a positive whole number; store listings call it first. */
export function requireListLimit(limit: number, operation: string): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`${operation} limit must be a positive whole number, got ${limit}`);
  }
}
