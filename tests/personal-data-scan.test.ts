import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as privacy from "../scripts/personal-data-scan.ts";

const { scanText } = privacy;

const phone = ["+", "1", "212", "555", "0111"].join("");
const sid = `AC${"a".repeat(32)}`;
const voice = "z".repeat(20);
const agent = `agent_${"z".repeat(24)}`;
const hostname = ["private-device", ".tail123456", ".ts.net"].join("");
const email = ["owner", "@", "private.invalid"].join("");
const person = ["Sample", " Person"].join("");
const address = ["42", " Private", " Street"].join("");

describe("personal data scan", () => {
  it("reports locations and categories for all privacy gates without retaining values", () => {
    const text = [
      phone,
      sid,
      `voice_id: "${voice}"`,
      agent,
      hostname,
      email,
      `ownerName: "${person}"`,
      address,
    ].join("\n");
    const findings = scanText("fixture.txt", text);
    expect(new Set(findings.map(({ category }) => category))).toEqual(
      new Set("phone twilio_sid voice_id agent_id tailnet_hostname email name address".split(" ")),
    );
    expect(findings.every(({ file, line }) => file === "fixture.txt" && line > 0)).toBe(true);
    for (const value of [phone, sid, voice, agent, hostname, email, person, address]) {
      expect(JSON.stringify(findings)).not.toContain(value);
    }
  });

  it("accepts explicitly fictional contacts, roles, addresses and infrastructure", () => {
    expect(
      scanText(
        "fixture.txt",
        [
          "+15555550102",
          "+15550100100",
          "owner@example.com",
          "https://public.booker.example",
          'ownerName: "Example Owner"',
          'voice_id: "voice-example"',
          'agent_id: "agent-example"',
          "100 Fictional Example Street",
          "BOOKER_OWNER_NAME=",
          "ELEVENLABS_VOICE_ID=",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    [`BOOKER_OWNER_NAME=${person}`, "name"],
    [`BOOKER_OWNER_NAME = ${person} # local contact`, "name"],
    [`set("BOOKER_OWNER_NAME", "${person}")`, "name"],
    [`ELEVENLABS_VOICE_ID=${voice}`, "voice_id"],
    [`set("ELEVENLABS_VOICE_ID", "${voice}")`, "voice_id"],
    [`{"voice": "${voice}"}`, "voice_id"],
  ])("B48-1 catches assignment or tuple fixture %$", (text, category) => {
    const findings = scanText("configuration.txt", text);
    expect(findings.some((finding) => finding.category === category)).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(text);
  });

  it.each([
    ["612", "345", "678"].join(" "),
    ["612", "345", "678"].join(""),
    ["0034", "612", "345", "678"].join(" "),
    ["91", "234", "56", "78"].join(" "),
    ["612", "345", "678"].join("."),
    ["612", "345", "678"].join("-"),
  ])("B48-2 catches Spanish phone fixture %$", (text) => {
    expect(scanText("contacts.txt", text).some(({ category }) => category === "phone")).toBe(true);
  });

  it.each([
    ["Calle", "Fictional", "123,", "28000", "Madrid"].join(" "),
    ["C/", "Fictional", "5"].join(" "),
    ["Avda.", "Fictional", "5"].join(" "),
    ["Paseo", "Fictional", "5"].join(" "),
    ["742", "Evergreen", "Terrace"].join(" "),
    ...["Drive", "Way", "Court", "Place", "Parkway"].map((suffix) =>
      ["42", "Private", suffix].join(" "),
    ),
  ])("B48-2 catches postal location fixture %$", (text) => {
    expect(scanText("contacts.txt", text).some(({ category }) => category === "address")).toBe(
      true,
    );
  });

  it.each([
    [`phnum_${"z".repeat(26)}`, "phone_number_id"],
    [["100", "64", "0", "1"].join("."), "tailnet_ip"],
    [["100", "127", "255", "254"].join("."), "tailnet_ip"],
    [["fd7a", "115c", "a1e0", "abcd", "", "1"].join(":"), "tailnet_ip"],
  ])("B48-3 catches provider or tailnet fixture %$", (text, expected) => {
    const findings = scanText("network.txt", text);
    expect(findings.some(({ category }) => category === expected)).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(text);
  });

  it("accepts only exact fictional names and rejects personal suffixes", () => {
    expect(scanText("contacts.txt", `ownerName: "Example Owner ${person}"`)).toHaveLength(1);
    expect(scanText("contacts.txt", "BOOKER_OWNER_NAME=Example Owner 12")).toEqual([]);
    expect(scanText("contacts.txt", 'set("BOOKER_OWNER_NAME", "Example Owner 2")')).toEqual([]);
  });

  it("keeps empty assignments, ordinary versions and non-tailnet IPs clean", () => {
    expect(
      scanText(
        "configuration.txt",
        [
          "BOOKER_OWNER_NAME=\nBOOKER_PORT=3000",
          "ELEVENLABS_VOICE_ID=\nOTHER=example",
          "gitleaks 8.30.1 released 2026-09-24",
          ["100", "63", "255", "255"].join("."),
          ["100", "128", "0", "1"].join("."),
          '["BOOKER_OWNER_NAME", "BOOKER_PORT", "PUBLIC_BASE_URL"]',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("matches case-insensitive exact values in free text before fictional allowances", () => {
    const known = [person, "Example Owner 7"];
    const findings = scanText(
      "notes.txt",
      `${person.toUpperCase()}\nownerName: "${known[1]}"`,
      known,
    );
    expect(findings.filter(({ category }) => category === "denylisted_value")).toEqual([
      { category: "denylisted_value", file: "notes.txt", line: 1 },
      { category: "denylisted_value", file: "notes.txt", line: 2 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(person);
  });

  it("does not match a short fictional name inside words or unrelated camel tokens", () => {
    const text = "minted peppermint emitInvoice fromArgv customArtifact";
    expect(scanText("code.ts", text, ["Mint", "Arg"])).toEqual([]);
  });

  it("does not treat a public repository slug substring as a name token", () => {
    expect(scanText("README.md", "https://github.com/examplemint/booker", ["Mint"])).toEqual([]);
  });

  it.each([
    "Mint",
    "mInT",
    "MINT",
    "(mint)",
    "mint's",
    "mint’s",
    "mint-name",
    "mint_name",
    "ownerMint",
    "MintOwner",
    "XMLMintOwner",
    "mintOwner",
    "ownerMINT",
    "MINT_Name",
    "mint42",
    "42mint",
    "mint\n",
    "mint\u200b",
    "mint—name",
    "mint.équipe",
    "https://github.com/mint/booker",
    "https://mint.example/path",
    "mint@example.com",
  ])("detects a fictional name token across delimiters and identifiers %$", (text) => {
    expect(scanText("notes.txt", text, ["Mint"])).toContainEqual({
      category: "denylisted_value",
      file: "notes.txt",
      line: 1,
    });
  });

  it("uses Unicode letters, combining marks and camel boundaries for name tokens", () => {
    expect(scanText("code.ts", "éMinté peppermint", ["Mint"])).toEqual([]);
    for (const text of ["(ÉLIN)", "ownerÉlin", "E\u0301lin"]) {
      expect(
        scanText("code.ts", text, ["Élin"]).some(({ category }) => category === "denylisted_value"),
      ).toBe(true);
    }
    expect(scanText("notes.txt", "élinde", ["Élin"])).toEqual([]);
  });

  it.each([
    "Example Person",
    "100 Fictional Example Street",
    "owner@example.com",
    "+15550102",
    "fixture.token",
    "fake_identifier",
    "fixture-secret-42",
  ])("keeps non-name exact values embedded in other text blocked %$", (value) => {
    const findings = scanText("notes.txt", `prefix${value.toUpperCase()}suffix`, [value]);
    expect(findings.some(({ category }) => category === "denylisted_value")).toBe(true);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain(value.toLowerCase());
  });

  it("keeps explicitly exact alphabetic credentials blocked inside identifiers", async () => {
    const value = "FictionalCredential";
    const values = await privacy.loadDenylist({ ELEVENLABS_WEBHOOK_SECRET: value });
    expect(scanText("code.ts", `prefix${value.toLowerCase()}suffix`, values)).toContainEqual({
      category: "denylisted_value",
      file: "code.ts",
      line: 1,
    });
  });

  it("detects mixed-case name tokens within camel identifiers", () => {
    for (const text of ["ownerMiNt", "XMLMiNtOwner", "mInTOwner"]) {
      expect(
        scanText("code.ts", text, ["Mint"]).some(({ category }) => category === "denylisted_value"),
      ).toBe(true);
    }
  });

  it("retains original line numbers after Unicode case conversion", () => {
    expect(scanText("notes.txt", "İ".repeat(30) + "\nfixture.token\n", ["fixture.token"])).toEqual([
      { category: "denylisted_value", file: "notes.txt", line: 2 },
    ]);
  });

  it("reports each denied occurrence on its original line without values", () => {
    expect(scanText("notes.txt", "minted\nownerMint\nMINT\n", ["Mint", "mint", " "])).toEqual([
      { category: "denylisted_value", file: "notes.txt", line: 2 },
      { category: "denylisted_value", file: "notes.txt", line: 3 },
    ]);
  });

  it("loads exact values only from runtime environment and a read-only Keychain reader", async () => {
    const calls: string[] = [];
    const values = await privacy.loadDenylist(
      {
        BOOKER_OWNER_NAME: person,
        BOOKER_PRIVACY_DENYLIST: `\n${address}\n${person}\n`,
        BOOKER_PRIVACY_KEYCHAIN_ACCOUNTS: "BOOKER_OWNER_EMAIL",
      },
      async (account) => {
        calls.push(account);
        return account === "BOOKER_OWNER_EMAIL" ? email : undefined;
      },
    );
    expect(values).toEqual(
      expect.arrayContaining([person, address, { value: email, exact: true }]),
    );
    expect(values.filter((value) => value === person)).toHaveLength(1);
    expect(calls).toContain("BOOKER_OWNER_EMAIL");
    expect(calls).toContain("ELEVENLABS_VOICE_ID");
  });

  it("loads webhook credentials and cached multiline contacts without a denylist file", async () => {
    const values = await privacy.loadDenylist(
      { ELEVENLABS_WEBHOOK_SECRET: voice },
      async (account) =>
        account === "BOOKER_PRIVACY_DENYLIST" ? `${person}\n${address}` : undefined,
    );
    expect(values).toEqual(
      expect.arrayContaining([{ value: voice, exact: true }, person, address]),
    );
  });

  it("runs the privacy gate in CI after tests", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toMatch(/- run: pnpm test\s+- run: pnpm privacy:scan/);
    expect(workflow).toMatch(
      /- name: Install gitleaks[^\n]*\n\s+working-directory: \$\{\{ runner.temp \}\}/,
    );
  });

  it("fails closed with a value-free error if Keychain reads fail", async () => {
    await expect(
      privacy.loadDenylist({}, async () => {
        throw new Error(person);
      }),
    ).rejects.toEqual(new Error("Privacy denylist could not read Keychain"));
  });

  it("scans tracked and untracked export files but never reads ignored local configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "booker-privacy-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(join(root, ".gitignore"), ".env\n.local/\n");
      writeFileSync(join(root, ".env"), phone);
      mkdirSync(join(root, ".local"));
      writeFileSync(join(root, ".local", "contact.txt"), email);
      writeFileSync(join(root, "README.md"), "Fictional example");
      execFileSync("git", ["-C", root, "add", ".gitignore", "README.md"]);
      const report = join(tmpdir(), `booker-privacy-report-${process.pid}.json`);
      const script = new URL("../scripts/personal-data-scan.ts", import.meta.url).pathname;
      expect(
        spawnSync(process.execPath, [script, "--root", root, "--report", report], {
          env: { ...process.env, BOOKER_PRIVACY_KEYCHAIN: "0", BOOKER_PRIVACY_DENYLIST: "" },
        }).status,
      ).toBe(0);
      writeFileSync(join(root, "new-contact.txt"), phone);
      const result = spawnSync(process.execPath, [script, "--root", root, "--report", report], {
        encoding: "utf8",
        env: { ...process.env, BOOKER_PRIVACY_KEYCHAIN: "0", BOOKER_PRIVACY_DENYLIST: "" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("new-contact.txt");
      expect(result.stdout).not.toContain(phone);
      const json = readFileSync(report, "utf8");
      expect(json).not.toContain(phone);
      expect(json).not.toContain(".env");
      writeFileSync(join(root, "new-contact.txt"), `Contact ${person.toUpperCase()}`);
      const denied = spawnSync(process.execPath, [script, "--root", root, "--report", report], {
        encoding: "utf8",
        env: { ...process.env, BOOKER_PRIVACY_KEYCHAIN: "0", BOOKER_PRIVACY_DENYLIST: person },
      });
      expect(denied.status).toBe(1);
      expect(denied.stdout).toContain("denylisted_value");
      expect(JSON.parse(denied.stdout).denylistedValues).toBeGreaterThan(0);
      expect(denied.stdout.toLowerCase()).not.toContain(person.toLowerCase());
      expect(denied.stderr).not.toContain(person);
      expect(readFileSync(report, "utf8").toLowerCase()).not.toContain(person.toLowerCase());
      rmSync(report, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
