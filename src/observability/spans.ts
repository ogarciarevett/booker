import { type Attributes, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

// OpenInference attribute names, which Phoenix reads:
// https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
/** Phoenix groups every trace carrying the same `session.id` into one session: one phone call. */
export const SESSION_ID = "session.id";
export const SPAN_KIND = "openinference.span.kind";
export const TOOL_NAME = "tool.name";
export const LLM_MODEL_NAME = "llm.model_name";
export const LLM_PROMPT_TOKENS = "llm.token_count.prompt";
export const LLM_COMPLETION_TOKENS = "llm.token_count.completion";
/** OpenTelemetry's low-cardinality error class: an error's name, never its message. */
export const ERROR_TYPE = "error.type";

/**
 * Booker's tracer. Without the SDK (tracing off) the OpenTelemetry API hands out no-op spans, so
 * these helpers cost a few function calls and record nothing.
 */
export function bookerTracer(): Tracer {
  return trace.getTracer("booker");
}

/** Files the active span (a traced request's) under the session of the call it turned out to be for. */
export function joinCallSession(callId: string): void {
  trace.getActiveSpan()?.setAttribute(SESSION_ID, callId);
}

/** Adds attributes to the active span, when there is one. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/**
 * Runs `work` in a new active span, so spans started inside it (an outgoing `fetch`, say) are its
 * children. A thrown error marks the span failed with the error's name only, since a message can
 * carry data, and is rethrown.
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  tracer: Tracer = bookerTracer(),
): Promise<T> {
  return await tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ERROR_TYPE, error instanceof Error ? error.name : typeof error);
      throw error;
    } finally {
      span.end();
    }
  });
}
