import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_NAME, shownEndpoint, tracingSettings } from "./settings.ts";

const PHOENIX = "http://127.0.0.1:6006/v1/traces";

describe("tracingSettings", () => {
  it("is off when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is unset, empty, or blank", () => {
    for (const value of [undefined, "", "   "]) {
      expect(tracingSettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value })).toEqual({
        status: "off",
      });
    }
  });

  it("is disabled when OTEL_SDK_DISABLED is true, whatever the endpoint", () => {
    expect(
      tracingSettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: PHOENIX, OTEL_SDK_DISABLED: " TRUE " }),
    ).toEqual({ status: "disabled" });
    expect(
      tracingSettings({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a url",
        OTEL_SDK_DISABLED: "true",
      }),
    ).toEqual({ status: "disabled" });
    expect(tracingSettings({ OTEL_SDK_DISABLED: "true" })).toEqual({ status: "off" });
    expect(
      tracingSettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: PHOENIX, OTEL_SDK_DISABLED: "false" }),
    ).toMatchObject({ status: "on" });
  });

  it("is on with the endpoint and the default service name", () => {
    expect(tracingSettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ` ${PHOENIX} ` })).toEqual({
      status: "on",
      endpoint: PHOENIX,
      serviceName: DEFAULT_SERVICE_NAME,
    });
    expect(DEFAULT_SERVICE_NAME).toBe("booker");
  });

  it("takes the service name from OTEL_SERVICE_NAME when it is set", () => {
    expect(
      tracingSettings({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: PHOENIX,
        OTEL_SERVICE_NAME: "booker-dev",
      }),
    ).toMatchObject({ status: "on", serviceName: "booker-dev" });
    expect(
      tracingSettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: PHOENIX, OTEL_SERVICE_NAME: " " }),
    ).toMatchObject({ serviceName: DEFAULT_SERVICE_NAME });
  });

  it("names an endpoint that is not an http(s) URL without echoing it", () => {
    for (const value of ["phoenix-host:6006/v1/traces", "ftp://collector.test/v1", "not a url"]) {
      const settings = tracingSettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value });
      expect(settings.status).toBe("invalid");
      expect(JSON.stringify(settings)).not.toContain(value);
      expect(settings).toMatchObject({
        issue: expect.stringContaining("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
      });
    }
  });
});

describe("shownEndpoint", () => {
  it("drops credentials, the query, and the fragment before an endpoint is printed", () => {
    expect(shownEndpoint("https://user:pass@collector.example:4318/v1/traces?key=abc#x")).toBe(
      "https://collector.example:4318/v1/traces",
    );
    expect(shownEndpoint(PHOENIX)).toBe(PHOENIX);
  });
});
