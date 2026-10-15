import { describe, expect, it } from "vitest";
import { dashboardPort, guardRequest } from "./request-guard.ts";

const PORT = "3100";

function request(path: string, headers: Record<string, string>, method = "GET") {
  return { method, pathname: path, headers: new Headers(headers) };
}

describe("dashboardPort", () => {
  it("is the port Next.js serves on, 3100 unless PORT says otherwise", () => {
    expect(dashboardPort({})).toBe("3100");
    expect(dashboardPort({ PORT: "3200" })).toBe("3200");
    expect(dashboardPort({ PORT: "not-a-port" })).toBe("3100");
  });
});

describe("guardRequest", () => {
  it("serves requests addressed to this dashboard on loopback", () => {
    for (const host of ["127.0.0.1:3100", "localhost:3100", "LOCALHOST:3100"]) {
      expect(guardRequest(request("/", { Host: host }), PORT)).toEqual({ allowed: true });
    }
  });

  it("refuses any other host with 421, which defeats DNS rebinding", () => {
    for (const host of ["evil.example:3100", "127.0.0.1:3200", "127.0.0.1", "0.0.0.0:3100", ""]) {
      expect(guardRequest(request("/calls/call-1", { Host: host }), PORT)).toMatchObject({
        allowed: false,
        status: 421,
      });
    }
    expect(guardRequest(request("/", {}), PORT)).toMatchObject({ allowed: false, status: 421 });
  });

  it("refuses the event stream and any write from another site or origin", () => {
    const host = { Host: "127.0.0.1:3100" };
    const refused = [
      request("/api/events", { ...host, "Sec-Fetch-Site": "cross-site" }),
      request("/api/events", { ...host, "Sec-Fetch-Site": "same-site" }),
      request("/api/events", { ...host, Origin: "http://evil.example" }),
      request("/api/events", { ...host, Origin: "http://127.0.0.1:6006" }),
      request("/api/events", { ...host, Origin: "null" }),
      request("/", { ...host, Origin: "http://evil.example" }, "POST"),
    ];
    for (const input of refused) {
      expect(guardRequest(input, PORT)).toMatchObject({ allowed: false, status: 403 });
    }
    expect(
      guardRequest(
        request("/api/events", {
          ...host,
          "Sec-Fetch-Site": "same-origin",
          Origin: "http://127.0.0.1:3100",
        }),
        PORT,
      ),
    ).toEqual({ allowed: true });
  });

  it("lets a link from elsewhere open a page, but not frame or fetch it", () => {
    const host = { Host: "127.0.0.1:3100", "Sec-Fetch-Site": "cross-site" };
    expect(
      guardRequest(
        request("/calls/call-1", {
          ...host,
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        }),
        PORT,
      ),
    ).toEqual({ allowed: true });
    for (const dest of ["iframe", "empty", "script"]) {
      expect(
        guardRequest(
          request("/calls/call-1", {
            ...host,
            "Sec-Fetch-Mode": "no-cors",
            "Sec-Fetch-Dest": dest,
          }),
          PORT,
        ),
      ).toMatchObject({ allowed: false, status: 403 });
    }
  });
});
