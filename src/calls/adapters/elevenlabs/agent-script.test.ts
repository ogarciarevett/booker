import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_SCRIPT_PATH, loadAgentScript } from "./agent-script.ts";
import { toolNamesFor } from "./tools.ts";

const REPO_ROOT = process.cwd();

describe("public English scripts", () => {
  it.each(["demo", "roleplay-gpu"])("uses only owner_name for %s identity", async (profile) => {
    const script = await loadAgentScript(join(REPO_ROOT, `locales/en-US/${profile}.yaml`));

    for (const text of [script.firstMessage, ...Object.values(script.prompts)]) {
      expect(new Set(referencedVariables(text))).toEqual(new Set(["owner_name"]));
    }
  });
});

describe("the en-US GPU role-play script", () => {
  it("parses with the existing schema and opens with the exact English consent request", async () => {
    const script = await loadAgentScript(join(REPO_ROOT, "locales/en-US/roleplay-gpu.yaml"));

    expect(script.language).toBe("en");
    expect(script.firstMessage).toBe(
      "Hi, this is {{owner_name}}'s AI booker calling for a short role-play test. Is it okay to continue for a couple of minutes?",
    );
    for (const prompt of Object.values(script.prompts)) {
      expect(prompt).toContain("H100");
      expect(prompt).toContain("H200");
      expect(prompt).toContain("end_call");
      expect(prompt).not.toContain("request_commit_permission");
      expect(new Set(referencedVariables(prompt))).toEqual(new Set(["owner_name"]));
    }
  });
});

describe("the en-US Booker demo script", () => {
  it("parses with the existing schema and opens with the exact English demo consent request", async () => {
    const script = await loadAgentScript(join(REPO_ROOT, "locales/en-US/demo.yaml"));

    expect(script.language).toBe("en");
    expect(script.firstMessage).toBe(
      "Hi, this is {{owner_name}}'s AI booker calling to show you what booker can do. Is it okay to continue for two minutes?",
    );
    for (const prompt of Object.values(script.prompts)) {
      expect(prompt).toContain("end_call");
      expect(prompt).toContain("restaurant");
      expect(prompt).toContain("repair service");
      expect(prompt).not.toContain("request_commit_permission");
      expect(new Set(referencedVariables(prompt))).toEqual(new Set(["owner_name"]));
    }
  });
});

/** Every `{{name}}` an agent text references: each must be sent with every call. */
function referencedVariables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1] ?? "");
}

describe("the es-ES agent script", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("loads from locales/es-ES/agent.yaml with a first message and a prompt per purpose", async () => {
    const script = await loadAgentScript(join(REPO_ROOT, AGENT_SCRIPT_PATH));

    expect(script.language).toBe("es");
    expect(script.firstMessage.length).toBeGreaterThan(40);
    expect(script.prompts.quote.length).toBeGreaterThan(200);
    expect(script.prompts.commit.length).toBeGreaterThan(200);
  });

  it("says in the first message whom it calls for and that it is an AI assistant, so neither is lost", async () => {
    const script = await loadAgentScript(join(REPO_ROOT, AGENT_SCRIPT_PATH));

    expect(script.firstMessage).toContain("{{owner_name}}");
    expect(script.firstMessage).toMatch(/asistente de IA/);
  });

  it("describes the first message truthfully in its comment", async () => {
    const source = await readFile(join(REPO_ROOT, AGENT_SCRIPT_PATH), "utf8");
    const comment = source.slice(0, source.indexOf("first_message:")).split("\n\n").at(-1) ?? "";

    expect(comment).toContain("AI assistant");
    expect(comment).not.toContain("automated system");
  });

  it("names the owner in the first message, and references no variable but owner_name", async () => {
    const script = await loadAgentScript(join(REPO_ROOT, AGENT_SCRIPT_PATH));

    expect(referencedVariables(script.firstMessage)).toContain("owner_name");
    for (const text of [script.firstMessage, script.prompts.quote, script.prompts.commit]) {
      expect(new Set(referencedVariables(text))).toEqual(new Set(["owner_name"]));
      expect(text).not.toContain("call_token");
    }
  });

  it("tells each agent to fetch the context first and to end the call, naming only its own tools", async () => {
    const script = await loadAgentScript(join(REPO_ROOT, AGENT_SCRIPT_PATH));

    for (const purpose of ["quote", "commit"] as const) {
      const prompt = script.prompts[purpose];
      expect(prompt).toContain("get_errand_context");
      expect(prompt).toContain("end_call");
      expect(prompt).toContain("record_cost_item");
    }
    expect(script.prompts.commit).toContain("request_commit_permission");
    expect(script.prompts.commit).toContain("report_commit_outcome");
    for (const commitOnly of ["request_commit_permission", "report_commit_outcome"]) {
      expect(toolNamesFor("quote")).not.toContain(commitOnly);
      expect(script.prompts.quote).not.toContain(commitOnly);
    }
  });

  it("refuses a script that misses a text, naming the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-agent-script-"));
    const path = join(dir, "agent.yaml");
    writeFileSync(path, "language: es\nfirst_message: Hello {{owner_name}}\n");

    await expect(loadAgentScript(path)).rejects.toThrow(path);
  });
});
