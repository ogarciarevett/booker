import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Fixtures are assembled at runtime so this file never contains a matching literal.
const fixtures: Record<string, string> = {
  "elevenlabs-key": `key = "${"sk_"}${"a".repeat(48)}"`,
  "anthropic-oauth": `token = "${"sk-ant-"}${"oat01-"}${"Xy9_".repeat(10)}"`,
  "phone-plus-spaced": ["+34", "612", "345", "678"].join(" "),
  "phone-plus-compact": ["+34", "612", "345", "678"].join(""),
  "phone-double-zero": ["0034", "969", "22", "00", "66"].join(" "),
  "phone-parenthesized": ["(+34)", "969", "22", "00", "66"].join(" "),
  "phone-national-mobile": ["612", "345", "678"].join(" "),
  "phone-national-landline": ["969", "22", "00", "66"].join(" "),
  "fictional-phone": "+1 555 555 0100",
  "version-and-date": "gitleaks 8.30.1 released 2026-09-24",
};

const expectedRules: Record<string, string | null> = {
  "elevenlabs-key": "elevenlabs-api-key",
  "anthropic-oauth": "anthropic-oauth-token",
  "phone-plus-spaced": "spanish-phone-number",
  "phone-plus-compact": "spanish-phone-number",
  "phone-double-zero": "spanish-phone-number",
  "phone-parenthesized": "spanish-phone-number",
  "phone-national-mobile": "spanish-phone-number-national",
  "phone-national-landline": "spanish-phone-number-national",
  "fictional-phone": null,
  "version-and-date": null,
};

type Finding = { RuleID: string; File: string };

const runGitleaks = (args: string[]): void => {
  try {
    execFileSync("gitleaks", args, { stdio: "pipe", timeout: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("gitleaks is not on PATH. Install it as described in CONTRIBUTING.md.");
    }
    throw error;
  }
};

let workDir: string;
let findings: Finding[];

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "booker-gitleaks-"));
  const fixtureDir = join(workDir, "fixtures");
  mkdirSync(fixtureDir);
  for (const [name, content] of Object.entries(fixtures)) {
    writeFileSync(join(fixtureDir, `${name}.txt`), `${content}\n`);
  }
  const reportPath = join(workDir, "report.json");
  runGitleaks([
    "dir",
    fixtureDir,
    "--config",
    ".gitleaks.toml",
    "--no-banner",
    "--redact",
    "--exit-code",
    "0",
    "--report-format",
    "json",
    "--report-path",
    reportPath,
  ]);
  findings = JSON.parse(readFileSync(reportPath, "utf8")) as Finding[];
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("secret and personal-data scanning", () => {
  it.each(Object.entries(expectedRules))("%s → %s", (fixture, rule) => {
    const rules = findings
      .filter((finding) => finding.File.endsWith(`${fixture}.txt`))
      .map((finding) => finding.RuleID);

    if (rule === null) {
      expect(rules).toEqual([]);
    } else {
      expect(rules).toContain(rule);
    }
  });
});
