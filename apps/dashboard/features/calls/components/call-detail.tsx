import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state.tsx";
import { StatusChip } from "@/components/status-chip.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInstant, formatOffset, formatValue, statusLabel } from "@/lib/format.ts";
import type { CallDetail, PhoenixLink } from "@/lib/types.ts";
import { cn } from "@/lib/utils";

interface TimelineEntry {
  readonly label: string;
  readonly at: string;
}

/** What happened to the call, in order, from the timestamps Booker recorded. */
function timeline(call: CallDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ label: "Placed", at: call.createdAt }];
  if (call.transcript !== null) {
    entries.push({ label: "Transcript received", at: call.transcript.receivedAt });
  }
  if (call.endedAt !== null)
    entries.push({ label: `Ended: ${statusLabel(call.status)}`, at: call.endedAt });
  for (const entry of call.booking?.history ?? []) {
    entries.push({ label: `Booking ${statusLabel(entry.status).toLowerCase()}`, at: entry.at });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

function PhoenixTrace({ phoenix }: { readonly phoenix: PhoenixLink }) {
  switch (phoenix.kind) {
    case "session":
      return (
        <Button asChild variant="outline" size="sm">
          <a href={phoenix.url} target="_blank" rel="noreferrer" className="no-underline">
            View trace in Phoenix
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      );
    case "missing":
      return (
        <p className="text-sm text-muted-foreground">
          No trace in Phoenix for this call. Traces are recorded while Booker runs with{" "}
          <code className="font-mono">pnpm serve:traced</code>.
        </p>
      );
    case "unreachable":
      return (
        <p className="text-sm text-muted-foreground">
          Phoenix is not running at {phoenix.phoenixUrl}: start it with{" "}
          <code className="font-mono">pnpm phoenix</code> to see this call's trace.
        </p>
      );
  }
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Fact({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm break-all", mono ? "font-mono" : null)}>{children}</dd>
    </div>
  );
}

/** Everything Booker knows about one call; server-rendered, so it holds no secrets to leak. */
export function CallDetailView({
  call,
  phoenix,
}: {
  readonly call: CallDetail;
  readonly phoenix: PhoenixLink;
}) {
  const provider = call.providerName ?? call.providerId;
  return (
    <article className="space-y-10">
      <header className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{provider}</h1>
          <StatusChip status={call.status} />
        </div>
        <dl className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-4">
          <Fact label="Number" mono>
            {call.providerPhone ?? "-"}
          </Fact>
          <Fact label="Purpose">
            {call.purpose}, attempt {call.attempt}
          </Fact>
          <Fact label="Errand" mono>
            {call.errandId}
          </Fact>
          <Fact label="Call" mono>
            {call.callId}
          </Fact>
        </dl>
        <PhoenixTrace phoenix={phoenix} />
      </header>

      <Section id="timeline" title="Timeline">
        <ol className="space-y-2 border-l pl-4 text-sm">
          {timeline(call).map((entry) => (
            <li key={`${entry.label}-${entry.at}`}>
              <time className="mr-2 text-muted-foreground" dateTime={entry.at}>
                {formatInstant(entry.at)}
              </time>
              {entry.label}
            </li>
          ))}
        </ol>
      </Section>

      <Section id="recorded" title="Recorded">
        {call.recorded.length === 0 ? (
          <EmptyState>Nothing recorded yet.</EmptyState>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableCaption className="sr-only">
                Values the agent recorded, known or estimated, with the provider's words
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Field</TableHead>
                  <TableHead scope="col">Value</TableHead>
                  <TableHead scope="col">Certainty</TableHead>
                  <TableHead scope="col">Provider said</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {call.recorded.map((field) => (
                  <TableRow key={field.field}>
                    <TableHead scope="row" className="font-mono font-normal text-foreground">
                      {field.field}
                    </TableHead>
                    <TableCell>{formatValue(field.value)}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          field.status === "known"
                            ? "border-status-success/40 text-status-success"
                            : "border-status-warning/50 text-status-warning"
                        }
                      >
                        {field.status === "known" ? "Known" : "Estimated"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <q>{field.quote}</q>{" "}
                      <time className="text-muted-foreground" dateTime={field.capturedAt}>
                        {formatInstant(field.capturedAt)}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <h3 className="pt-2 text-sm font-semibold">Still unknown</h3>
        {call.unknown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing left unknown.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {call.unknown.map((field) => (
              <li key={field}>
                <Badge variant="secondary" className="font-mono font-normal">
                  {field}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="booking" title="Grant and booking">
        <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
          <p>
            {call.grant === null ? (
              "No commit grant."
            ) : (
              <>
                Commit grant active until{" "}
                <time dateTime={call.grant.expiresAt}>{formatInstant(call.grant.expiresAt)}</time>.
              </>
            )}
          </p>
          {call.booking === null ? (
            <p className="text-muted-foreground">No open booking for this errand.</p>
          ) : (
            <p className="flex flex-wrap items-center gap-1.5">
              Booking <span className="font-mono">{call.booking.id}</span>
              {call.booking.providerId === call.providerId
                ? " with this provider"
                : " with another provider"}
              : <StatusChip status={call.booking.status} />
            </p>
          )}
        </div>
      </Section>

      <Section id="transcript" title="Transcript">
        {call.transcript === null ? (
          <EmptyState>
            No transcript yet. It arrives with the post-call webhook when the call ends.
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {call.transcript.turns.map((turn) => (
              <li
                key={`${turn.secondsIntoCall}-${turn.role}-${turn.message}`}
                className={cn(
                  "max-w-2xl rounded-lg border p-3 text-sm",
                  turn.role === "agent" ? "bg-card" : "ml-auto bg-muted",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {turn.role === "agent" ? "Booker" : "Provider"}
                  </span>
                  <time>{formatOffset(turn.secondsIntoCall)}</time>
                </div>
                <p>{turn.message}</p>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </article>
  );
}
