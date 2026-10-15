import type { Server } from "node:http";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { LOOPBACK_HOST } from "./config.ts";
import { listen, trackInFlight } from "./http-server.ts";

const created = vi.hoisted(() => [] as unknown[]);

// Keeps a handle on the Node server `listen` creates, so a test can make it emit an error
// after it is bound, which a real socket only does under conditions a test cannot arrange
// (running out of file descriptors while accepting, for one).
vi.mock("@hono/node-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hono/node-server")>();
  return {
    ...actual,
    createAdaptorServer: (...args: Parameters<typeof actual.createAdaptorServer>) => {
      const server = actual.createAdaptorServer(...args);
      created.push(server);
      return server;
    },
  };
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("listen", () => {
  it("reports an error the server emits after it is bound, and keeps serving", async () => {
    const errors: unknown[] = [];
    const app = new Hono().get("/ping", (c) => c.text("pong"));
    const server = await listen((request) => app.fetch(request), {
      host: LOOPBACK_HOST,
      port: 0,
      onError: (error) => errors.push(error),
    });
    try {
      const node = created.at(-1) as Server;
      const failure = new Error("EMFILE: too many open files");

      node.emit("error", failure);

      expect(errors).toEqual([failure]);
      const response = await fetch(`http://127.0.0.1:${server.port}/ping`);
      expect(await response.text()).toBe("pong");
    } finally {
      await server.close();
    }
  });
});

describe("trackInFlight", () => {
  it("settles only once a handler cut off by the shutdown grace has finished its work", async () => {
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const app = new Hono().post("/write", async (c) => {
      entered.resolve();
      await release.promise;
      events.push("write finished");
      return c.text("stored");
    });
    const tracked = trackInFlight((request) => app.fetch(request));
    const server = await listen(tracked.fetch, { host: LOOPBACK_HOST, port: 0 });

    const outcome = fetch(`http://127.0.0.1:${server.port}/write`, { method: "POST" }).then(
      () => "answered",
      () => "cut",
    );
    await entered.promise;
    await server.close(20);
    expect(await outcome).toBe("cut");
    expect(tracked.count()).toBe(1);

    const settling = tracked.settled(5_000).then((settled) => {
      events.push(settled ? "settled" : "timed out");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);

    release.resolve();
    await settling;
    expect(events).toEqual(["write finished", "settled"]);
    expect(tracked.count()).toBe(0);
  });

  it("stops waiting after the timeout and says so", async () => {
    const never = new Promise<Response>(() => {});
    const tracked = trackInFlight(() => never);
    void tracked.fetch(new Request("http://127.0.0.1/stuck"));

    expect(await tracked.settled(10)).toBe(false);
    expect(tracked.count()).toBe(1);
  });

  it("settles at once when nothing is running, and counts a failed handler as finished", async () => {
    const tracked = trackInFlight(async () => {
      throw new Error("handler failed");
    });
    await expect(tracked.fetch(new Request("http://127.0.0.1/x"))).rejects.toThrow(
      "handler failed",
    );

    expect(tracked.count()).toBe(0);
    expect(await tracked.settled(10)).toBe(true);
  });
});
