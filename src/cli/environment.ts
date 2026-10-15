import type { z } from "zod";

export type ParseEnvironmentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: string[] };

/**
 * Reads the variables `schema` names from `env`, where an empty value counts as unset. Problems
 * are reported per variable with a fixed message from `messages`, never with zod's own text,
 * which can quote the value (and these values are often secrets).
 */
export function parseEnvironment<Shape extends z.ZodRawShape>(
  env: Readonly<Record<string, string | undefined>>,
  schema: z.ZodObject<Shape>,
  messages: Readonly<Record<keyof Shape & string, string>>,
): ParseEnvironmentResult<z.infer<z.ZodObject<Shape>>> {
  const variables = Object.keys(schema.shape) as (keyof Shape & string)[];
  const input: Record<string, string> = {};
  for (const variable of variables) {
    const value = env[variable];
    if (value !== undefined && value !== "") input[variable] = value;
  }
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const invalid = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  return {
    ok: false,
    issues: variables.filter((variable) => invalid.has(variable)).map((name) => messages[name]),
  };
}
