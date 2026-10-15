import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { InMemoryBookingStore, InMemoryCommitGrantStore } from "../bookings/adapters/in-memory.ts";
import { InMemoryCallStore } from "../calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../calls/adapters/in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "../calls/adapters/in-memory-transcript-store.ts";
import { endCall } from "../calls/call.ts";
import { emptyOfferDraft } from "../calls/offer-drafts.ts";
import type { VoiceCallPort } from "../calls/voice-call-port.ts";
import { createControlApp } from "../http/control.ts";
import { estimated, known } from "../offers/field.ts";
import { saveSettingsFixture } from "../persistence/settings-fixture.ts";
import { controlTokenPath, ensureControlToken } from "../server/control-token.ts";
import { InMemorySecretStore } from "../settings/adapters/in-memory-secret-store.ts";
import { dateRangeSchema } from "../shared/dates.ts";
import { callCommand } from "./call.ts";
import type { CliContext } from "./context.ts";

const NOW = "2026-10-06T10:00:00.000Z";
const NORTHSIDE_PHONE = "+15555550100";

interface TestContext extends CliContext {
  readonly out: string[];
  readonly err: string[];
  readonly requests: { url: string; init: RequestInit }[];
}

describe("booker call", () => {
  let repoRoot: string;
  let calls: InMemoryCallStore;
  let errands: InMemoryErrandStore;
  let offers: InMemoryOfferStore;
  let onSleep: () => Promise<void>;

  async function context(env: Record<string, string> = {}): Promise<TestContext> {
    const { token } = await ensureControlToken(controlTokenPath(repoRoot));
    const voice: VoiceCallPort = {
      placeCall: async () => ({ externalId: "conv-001", callSid: null }),
      cancelCall: async () => {},
    };
    const app = createControlApp({
      token,
      calls,
      errands,
      offers,
      transcripts: new InMemoryTranscriptStore(),
      grants: new InMemoryCommitGrantStore(),
      bookings: new InMemoryBookingStore(),
      now: () => NOW,
      errandRoot: join(repoRoot, ".local"),
      voice: async () => ({ ok: true, port: voice }),
    });
    const out: string[] = [];
    const err: string[] = [];
    const requests: { url: string; init: RequestInit }[] = [];
    return {
      repoRoot,
      env,
      secrets: new InMemorySecretStore(),
      dotenvNames: new Set(),
      signals: new EventEmitter(),
      fetch: async (url, init) => {
        requests.push({ url, init });
        return await app.request(url, init);
      },
      sleep: () => onSleep(),
      out,
      err,
      requests,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    };
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "booker-call-"));
    mkdirSync(join(repoRoot, ".local", "errands"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".local", "errands", "test.json"),
      JSON.stringify(drivingSchoolBrief),
    );
    calls = new InMemoryCallStore();
    errands = new InMemoryErrandStore();
    offers = new InMemoryOfferStore();
    onSleep = async () => {};
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("asks the running server to place the call and prints its ids", async () => {
    const ctx = await context();

    const exitCode = await callCommand.run(
      ["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json"],
      ctx,
    );

    expect(exitCode).toBe(0);
    expect(ctx.requests[0]?.url).toBe("http://127.0.0.1:8787/control/calls");
    expect(JSON.parse(String(ctx.requests[0]?.init.body))).toEqual({
      to: NORTHSIDE_PHONE,
      errandFile: join(repoRoot, ".local", "errands", "test.json"),
      purpose: "quote",
    });
    expect(ctx.out.join("\n")).toMatch(/Placed call call-\S+ \(conversation conv-001\)/);
    expect((await calls.listOpen()).length).toBe(1);
  });

  it("says the saved settings cannot be read instead of crashing", async () => {
    const dataDir = join(repoRoot, ".local", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "booker.db"), "this is not a database, only text long enough");
    const ctx = await context();

    const exitCode = await callCommand.run(
      ["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json"],
      ctx,
    );

    expect(exitCode).toBe(1);
    expect(ctx.err.join("\n")).toMatch(
      /^Cannot call: The saved settings in .+booker\.db could not be read: SQLITE_NOTADB/,
    );
    expect(ctx.requests).toEqual([]);
  });

  it("reaches the server on the port saved in the dashboard", async () => {
    await saveSettingsFixture(repoRoot, { BOOKER_PORT: "9100" });
    const ctx = await context();

    const exitCode = await callCommand.run(
      ["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json"],
      ctx,
    );

    expect(exitCode).toBe(0);
    expect(ctx.requests[0]?.url).toBe("http://127.0.0.1:9100/control/calls");
  });

  it("waits for the call to end, then prints what was recorded and what is still unknown", async () => {
    const ctx = await context({ BOOKER_PORT: "9999" });
    let polls = 0;
    onSleep = async () => {
      polls += 1;
      if (polls < 2) return;
      const [open] = await calls.listOpen();
      if (open === undefined) return;
      const evidence = { source: "call" as const, reference: open.id, quote: "x", capturedAt: NOW };
      await offers.save({
        ...emptyOfferDraft(open.errandId, open.providerId, NOW),
        location: known("Northside district", evidence),
        deposit: estimated({ amountCents: 15_000, currency: "EUR" }, evidence),
        dates: known(dateRangeSchema.parse({ start: "2026-11-03", end: "2026-11-12" }), evidence),
      });
      const ended = endCall(open, "completed", NOW);
      if (ended.ok) await calls.update(ended.call);
    };

    const exitCode = await callCommand.run(
      ["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json", "--wait"],
      ctx,
    );

    expect(exitCode).toBe(0);
    expect(ctx.requests.at(-1)?.url).toMatch(/^http:\/\/127\.0\.0\.1:9999\/control\/calls\/call-/);
    const printed = ctx.out.join("\n");
    expect(printed).toContain("ended: completed");
    expect(printed).toMatch(/location +known +Northside district/);
    expect(printed).toMatch(/deposit +estimated +150\.00 EUR/);
    expect(printed).toMatch(/dates +known +2026-11-03 to 2026-11-12/);
    expect(printed).toMatch(/Still unknown: .*seatsAvailable/);
  });

  it("says the server is not running when nothing answers", async () => {
    const ctx = await context();
    const refused: CliContext["fetch"] = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    };

    const exitCode = await callCommand.run(
      ["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json"],
      { ...ctx, fetch: refused },
    );

    expect(exitCode).toBe(1);
    expect(ctx.err.join("\n")).toContain("not running");
    expect(ctx.err.join("\n")).toContain("pnpm booker serve");
  });

  it("explains a refusal from the server", async () => {
    const ctx = await context();

    const exitCode = await callCommand.run(
      ["--to", "+15550100999", "--errand", ".local/errands/test.json"],
      ctx,
    );

    expect(exitCode).toBe(1);
    expect(ctx.err.join("\n")).toContain("not the phone number of any provider");
  });

  it("needs the control token the server creates on its first start", async () => {
    const ctx = await context();
    rmSync(controlTokenPath(repoRoot));

    const exitCode = await callCommand.run(
      ["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json"],
      ctx,
    );

    expect(exitCode).toBe(1);
    expect(ctx.err.join("\n")).toContain("pnpm booker serve");
    expect(ctx.requests).toEqual([]);
  });

  it.each([
    [[]],
    [["--to", NORTHSIDE_PHONE]],
    [["--to", "555 0100", "--errand", "x.json"]],
    [["--to", NORTHSIDE_PHONE, "--errand", "x.json", "--now"]],
  ])("prints usage and exits 2 for %j", async (args) => {
    const ctx = await context();

    expect(await callCommand.run(args, ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("pnpm booker call --to <E.164> --errand <file> [--wait]");
    expect(ctx.requests).toEqual([]);
  });

  it("never prints the control token", async () => {
    const ctx = await context();
    const { token } = await ensureControlToken(controlTokenPath(repoRoot));

    await callCommand.run(["--to", NORTHSIDE_PHONE, "--errand", ".local/errands/test.json"], ctx);

    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(token);
  });
});
