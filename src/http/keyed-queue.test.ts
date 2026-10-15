import { describe, expect, it } from "vitest";
import { KeyedQueue } from "./keyed-queue.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("KeyedQueue", () => {
  it("runs operations on the same key one after another, in order", async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    const gate = deferred();

    const first = queue.run("errand-001", async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = queue.run("errand-001", async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not make an operation on another key wait", async () => {
    const queue = new KeyedQueue();
    const gate = deferred();
    const blocked = queue.run("errand-001", () => gate.promise);

    await expect(queue.run("errand-002", async () => "done")).resolves.toBe("done");
    gate.resolve();
    await blocked;
  });

  it("returns each operation's own error and keeps running the queue after it", async () => {
    const queue = new KeyedQueue();
    const failing = queue.run("errand-001", async () => {
      throw new Error("boom");
    });
    const next = queue.run("errand-001", async () => "still runs");

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("still runs");
  });
});
