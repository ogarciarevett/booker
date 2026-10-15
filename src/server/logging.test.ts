import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { describeError, withRequestLog } from "./logging.ts";

function randomSecret(): string {
  return randomBytes(24).toString("hex");
}

describe("describeError", () => {
  it("keeps the error name and only the first line of its message", () => {
    const error = new Error(
      "Failed query: insert into call_transcripts values (?, ?)\nparams: a,b",
    );

    expect(describeError(error, [])).toBe(
      "Error: Failed query: insert into call_transcripts values (?, ?)",
    );
  });

  it("adds the first line of the cause", () => {
    const cause = new TypeError("SQLITE_BUSY: database is locked\nmore detail");
    const error = new Error("Failed query: select 1\nparams: ", { cause });

    expect(describeError(error, [])).toBe(
      "Error: Failed query: select 1 (cause: TypeError: SQLITE_BUSY: database is locked)",
    );
  });

  it("redacts every given secret, also inside the cause", () => {
    const secret = randomSecret();
    const error = new Error(`bad key ${secret}`, { cause: new Error(`again ${secret}`) });

    const described = describeError(error, [secret]);

    expect(described).not.toContain(secret);
    expect(described).toBe("Error: bad key [redacted] (cause: Error: again [redacted])");
  });

  it("removes control characters and caps the length", () => {
    const error = new Error(`a\u0007b\u001b[31m${"x".repeat(500)}`);

    const described = describeError(error, []);

    expect(described).toMatch(/^Error: ab\[31mx+…$/);
    expect(Array.from(described)).toHaveLength(300);
  });

  it("never prints a thrown non-Error value", () => {
    const secret = randomSecret();

    expect(describeError(secret, [])).toBe("a non-Error value was thrown (string)");
  });
});

describe("withRequestLog", () => {
  it("logs one line per request with the method, path, status, and duration only", async () => {
    const lines: string[] = [];
    const key = randomSecret();
    const token = randomSecret();
    const app = new Hono();
    app.post("/voice-tools/:callId/get-errand-context", (c) =>
      c.json({ error: "unauthorized" }, 401),
    );
    const fetch = withRequestLog(
      (request) => app.fetch(request),
      (line) => lines.push(line),
    );

    const response = await fetch(
      new Request(`http://127.0.0.1/voice-tools/call-1/get-errand-context?token=${token}`, {
        method: "POST",
        headers: { "X-Booker-Tools-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ call_token: token }),
      }),
    );

    expect(response.status).toBe(401);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^POST \/voice-tools\/call-1\/get-errand-context 401 \d+ms$/);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("logs a request no route matches, with percent-encoding kept so it stays one line", async () => {
    const lines: string[] = [];
    const app = new Hono();
    const fetch = withRequestLog(
      (request) => app.fetch(request),
      (line) => lines.push(line),
    );

    await fetch(new Request("http://127.0.0.1/a%0Ab c"));

    expect(lines).toEqual([expect.stringMatching(/^GET \/a%0Ab%20c 404 \d+ms$/)]);
  });

  it("answers even when the logger throws", async () => {
    const app = new Hono();
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    const fetch = withRequestLog(
      (request) => app.fetch(request),
      () => {
        throw new Error("stdout is gone");
      },
    );

    const response = await fetch(new Request("http://127.0.0.1/healthz"));

    expect(response.status).toBe(200);
  });
});
