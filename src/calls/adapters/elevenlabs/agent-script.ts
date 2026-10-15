import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { CallPurpose } from "../../call.ts";

/** The default agent script, relative to the repository root: its Spanish text lives here. */
export const AGENT_SCRIPT_PATH = "locales/es-ES/agent.yaml";

/** What the agents say first and how they behave, per call purpose. */
export interface AgentScript {
  readonly language: string;
  readonly firstMessage: string;
  readonly prompts: Readonly<Record<CallPurpose, string>>;
}

const text = z.string().trim().min(1);

const agentScriptFileSchema = z.object({
  language: text,
  first_message: text,
  prompt: z.object({ shared: text, quote: text, commit: text }),
});

/**
 * Reads the agent script: the exact first message and the system prompt of each agent, which is
 * the shared prompt followed by the purpose's own rules. A file that misses a text is refused,
 * naming the file but never quoting it.
 */
export async function loadAgentScript(path: string): Promise<AgentScript> {
  const parsed = agentScriptFileSchema.safeParse(parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`${path} is not a valid agent script (check: ${fields.join(", ")})`);
  }
  const { language, first_message: firstMessage, prompt } = parsed.data;
  return {
    language,
    firstMessage,
    prompts: {
      quote: `${prompt.shared}\n\n${prompt.quote}`,
      commit: `${prompt.shared}\n\n${prompt.commit}`,
    },
  };
}
