import { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** How long a shutdown waits for in-flight requests before cutting their connections. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export interface ListeningServer {
  /** The bound port; useful when listening on port 0. */
  readonly port: number;
  /**
   * Stops accepting connections, lets in-flight requests finish for up to `graceMs`, then cuts
   * whatever is still open. Calling it again returns the same promise.
   */
  close(graceMs?: number): Promise<void>;
}

function closeGracefully(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}

export interface ListenOptions {
  readonly host: string;
  readonly port: number;
  /**
   * Receives an error the server emits after it is bound (running out of file descriptors while
   * accepting, for one). Without a listener such an error would end the process.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * Serves `fetch` over HTTP/1.1 with `@hono/node-server` on `host:port`, resolving once the
 * socket is bound and rejecting when it cannot be (a port already in use, for one). Later server
 * errors go to `onError` and never end the process. The global `Request` and `Response` are left
 * untouched.
 */
export async function listen(
  fetch: FetchHandler,
  options: ListenOptions,
): Promise<ListeningServer> {
  const server = createAdaptorServer({
    fetch,
    hostname: options.host,
    overrideGlobalObjects: false,
  });
  if (!(server instanceof Server)) throw new TypeError("expected an HTTP/1.1 server");

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => {
    try {
      options.onError?.(error);
    } catch {
      // A failing logger must not end the process either.
    }
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("expected the server to listen on a TCP port");
  }

  let closing: Promise<void> | undefined;
  // `server.close` closes the connections idle at that moment only. A keep-alive connection that
  // finishes its in-flight response later would hold the shutdown open until the client drops
  // it, so during shutdown each finished response closes the connections that are now idle.
  server.on("request", (_request, response) => {
    response.once("finish", () => {
      if (closing !== undefined) setImmediate(() => server.closeIdleConnections());
    });
  });

  return {
    port: address.port,
    close(graceMs = DEFAULT_SHUTDOWN_GRACE_MS) {
      closing ??= closeGracefully(server, graceMs);
      return closing;
    },
  };
}

export interface InFlightRequests {
  /** `fetch`, counting each request from its start until its handler settles. */
  readonly fetch: FetchHandler;
  /** How many handlers are still running. */
  count(): number;
  /**
   * Resolves `true` once no handler is running, or `false` after `timeoutMs` if some still are.
   * A handler keeps running after the shutdown grace cut its connection, so the database must
   * not close under it.
   */
  settled(timeoutMs: number): Promise<boolean>;
}

/** Wraps `fetch` so a shutdown can wait for handlers that outlive their connection. */
export function trackInFlight(fetch: FetchHandler): InFlightRequests {
  const running = new Set<Promise<unknown>>();
  return {
    fetch(request) {
      const handled = Promise.resolve().then(() => fetch(request));
      const tracked = handled.then(
        () => undefined,
        () => undefined,
      );
      running.add(tracked);
      void tracked.then(() => running.delete(tracked));
      return handled;
    },
    count: () => running.size,
    async settled(timeoutMs) {
      if (running.size === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const drained = (async () => {
        while (running.size > 0) await Promise.all(running);
        return true as const;
      })();
      try {
        return await Promise.race([drained, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
