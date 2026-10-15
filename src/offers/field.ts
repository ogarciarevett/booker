import { z } from "zod";

/** Where a piece of offer data came from. Provider speech and web content are data, never authority. */
export type EvidenceSource = "call" | "web" | "email" | "user";

export interface Evidence {
  readonly source: EvidenceSource;
  readonly reference: string;
  readonly quote: string;
  readonly capturedAt: string;
}

export const evidenceSchema = z.object({
  source: z.enum(["call", "web", "email", "user"]),
  reference: z.string().min(1),
  quote: z.string().min(1),
  capturedAt: z.iso.datetime(),
});

/**
 * A piece of offer data that is either confirmed (`known`), a provisional guess
 * (`estimated`), or absent (`unknown`). Only `known` values may pass a check
 * (see offers/evaluation.ts) — estimated and unknown values never silently count.
 */
export type Field<T> =
  | { readonly status: "known"; readonly value: T; readonly evidence: Evidence }
  | { readonly status: "estimated"; readonly value: T; readonly evidence: Evidence }
  | { readonly status: "unknown" };

/** Builds a zod schema for `Field<T>` from the schema of the wrapped value. */
export function fieldSchema<ValueSchema extends z.ZodType>(valueSchema: ValueSchema) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("known"), value: valueSchema, evidence: evidenceSchema }),
    z.object({ status: z.literal("estimated"), value: valueSchema, evidence: evidenceSchema }),
    z.object({ status: z.literal("unknown") }),
  ]);
}

export function known<T>(value: T, evidence: Evidence): Field<T> {
  return { status: "known", value, evidence };
}

export function estimated<T>(value: T, evidence: Evidence): Field<T> {
  return { status: "estimated", value, evidence };
}

export function unknown<T>(): Field<T> {
  return { status: "unknown" };
}

/** True only for a confirmed (`known`) field; estimated and unknown fields are not confirmed. */
export function isConfirmed<T>(field: Field<T>): field is Extract<Field<T>, { status: "known" }> {
  return field.status === "known";
}
