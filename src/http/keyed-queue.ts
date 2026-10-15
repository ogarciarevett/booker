/**
 * Runs operations that share a key one at a time, in arrival order; different keys never wait on
 * each other. The voice tools key by errand so two tool calls can never interleave a
 * read-modify-write of the same offer draft or grant binding within this process. Across
 * processes, the stores' own constraints (one active grant per errand, one open booking) still
 * decide.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    // The tail never rejects, so one failing operation does not block the ones queued after it.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
