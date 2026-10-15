import { describe, expect, it } from "vitest";
import { phoenixLink } from "./phoenix.ts";

const PHOENIX = "http://127.0.0.1:6006";

describe("phoenixLink", () => {
  it("links to the call's session page in its project", async () => {
    const asked: string[] = [];
    const link = await phoenixLink(PHOENIX, "call-1", async (url) => {
      asked.push(url);
      return new Response(
        JSON.stringify({ data: { id: "UHJvamVjdFNlc3Npb246MQ==", project_id: "UHJvamVjdDoy" } }),
      );
    });

    expect(asked).toEqual(["http://127.0.0.1:6006/v1/sessions/call-1"]);
    expect(link).toEqual({
      kind: "session",
      url: "http://127.0.0.1:6006/projects/UHJvamVjdDoy/sessions/UHJvamVjdFNlc3Npb246MQ==",
    });
  });

  it("says so when Phoenix has no session for the call", async () => {
    const link = await phoenixLink(
      PHOENIX,
      "call-1",
      async () => new Response("{}", { status: 404 }),
    );

    expect(link).toEqual({ kind: "missing", phoenixUrl: PHOENIX });
  });

  it("says so when Phoenix is not running or answers something else", async () => {
    const down = await phoenixLink(PHOENIX, "call-1", async () => {
      throw new TypeError("fetch failed");
    });
    const odd = await phoenixLink(PHOENIX, "call-1", async () => new Response("<html>"));

    expect(down).toEqual({ kind: "unreachable", phoenixUrl: PHOENIX });
    expect(odd).toEqual({ kind: "unreachable", phoenixUrl: PHOENIX });
  });
});
