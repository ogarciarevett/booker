import Link from "next/link";
import type { ReactNode } from "react";
import { ProgressBar } from "@/components/progress-bar.tsx";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ErrandDetail, ErrandProvider } from "@/lib/errands.ts";
import { formatInstant, formatMoney } from "@/lib/format.ts";
import { cn } from "@/lib/utils";
import { CountChips } from "./count-chips.tsx";
import { PROVIDER_STATUSES, STAGES, StatusIcon } from "./status-meta.tsx";

const EVALUATIONS = {
  eligible: { label: "Eligible", tone: "border-status-success/40 text-status-success" },
  incomplete: { label: "Incomplete", tone: "border-status-warning/50 text-status-warning" },
  ineligible: { label: "Ineligible", tone: "border-status-danger/40 text-status-danger" },
} as const;

function ProviderOffer({ provider }: { readonly provider: ErrandProvider }) {
  const { offer } = provider;
  if (offer === null) return null;
  return (
    <span className="text-right">
      <span className="block text-sm font-medium tabular-nums">
        {formatMoney(offer.total)}
        {offer.estimated ? <span className="text-status-warning"> (estimated)</span> : null}
      </span>
      {offer.perPerson === null ? null : (
        <span className="block text-xs text-muted-foreground tabular-nums">
          {formatMoney(offer.perPerson)} per person
        </span>
      )}
    </span>
  );
}

function ProviderRow({ provider }: { readonly provider: ErrandProvider }) {
  const meta = PROVIDER_STATUSES[provider.status];
  const content = (
    <>
      <StatusIcon meta={meta} className="mt-0.5" />
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{provider.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{provider.phone}</span>
        </span>
        <span className="block text-xs text-muted-foreground">
          <span className={cn("font-medium", meta.tone)}>{meta.label}</span> · {provider.attempts}{" "}
          of {provider.maxAttempts} attempts
          {provider.reasons.length === 0 ? null : <> · {provider.reasons.join("; ")}</>}
        </span>
        {provider.quote === undefined ? null : (
          <q className="block text-xs text-muted-foreground italic">{provider.quote}</q>
        )}
      </span>
      <ProviderOffer provider={provider} />
    </>
  );
  const row =
    "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-foreground no-underline outline-none transition-colors";
  return (
    <li>
      {provider.lastCallId === null ? (
        // Never called: nothing to open, so it is not a keyboard row.
        <div className={row}>{content}</div>
      ) : (
        <Link
          href={`/calls/${encodeURIComponent(provider.lastCallId)}`}
          data-board-row=""
          className={cn(row, "hover:bg-accent/60 focus-visible:bg-accent")}
        >
          {content}
        </Link>
      )}
    </li>
  );
}

function Panel({
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
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function nameOf(errand: ErrandDetail, providerId: string): string {
  return (
    errand.providers.find((provider) => provider.providerId === providerId)?.name ?? providerId
  );
}

function CommitLine({ errand }: { readonly errand: ErrandDetail }) {
  const { commit } = errand.missing;
  switch (commit.state) {
    case "none":
      return <>No commit grant or booking yet</>;
    case "grant_active":
      return (
        <>
          Commit grant for{" "}
          {commit.providerId === null ? "an unknown provider" : nameOf(errand, commit.providerId)}{" "}
          active until{" "}
          <time dateTime={commit.grantExpiresAt}>{formatInstant(commit.grantExpiresAt)}</time>
        </>
      );
    case "booked":
      return (
        <>
          Booked with {nameOf(errand, commit.providerId)} ({commit.bookingStatus})
        </>
      );
    case "enrolled":
      return <>Enrolled with {nameOf(errand, commit.providerId)}</>;
  }
}

const WRITTEN: Readonly<Record<ErrandDetail["missing"]["writtenConfirmation"], string>> = {
  not_required: "No written confirmation needed",
  pending: "Written confirmation pending",
  received: "Written confirmation received",
};

function MissingToClose({ errand }: { readonly errand: ErrandDetail }) {
  const { missing } = errand;
  return (
    <ul className="space-y-2 rounded-lg border bg-card p-4 text-sm">
      {missing.providersToCall.map((provider) => (
        <li key={provider.providerId}>Call {provider.name}</li>
      ))}
      {missing.leadingProviderId === null ? (
        <li className="text-muted-foreground">No quote to close on yet</li>
      ) : (
        <li>
          Best quote: {nameOf(errand, missing.leadingProviderId)}
          {missing.unknownFields.length === 0 ? (
            ", nothing left unknown"
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1">
              {missing.unknownFields.map((field) => (
                <li key={field}>
                  <Badge variant="secondary" className="font-mono font-normal">
                    {field}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </li>
      )}
      <li>{WRITTEN[missing.writtenConfirmation]}</li>
      <li>
        <CommitLine errand={errand} />
      </li>
    </ul>
  );
}

/**
 * One errand: its stage and progress, one row per provider with its outcome and reason, the
 * ranked quotes, and what is still missing before it can close.
 */
export function ErrandDetailView({ errand }: { readonly errand: ErrandDetail }) {
  const stage = STAGES[errand.stage];
  return (
    <article className="space-y-10">
      <header className="space-y-4">
        <div className="space-y-1.5">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <StatusIcon meta={stage} />
            <span className={cn("font-medium", stage.tone)}>{stage.label}</span>
            <span>·</span>
            <span className="font-mono text-xs">{errand.kind}</span>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{errand.objective}</h1>
        </div>
        <div className="flex max-w-xl items-center gap-3">
          <ProgressBar
            done={errand.progress.done}
            total={errand.progress.total}
            label={`${errand.progress.done} of ${errand.progress.total} providers settled`}
          />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {errand.progress.done} of {errand.progress.total} settled
          </span>
        </div>
        <CountChips counts={errand.counts} />
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel id="providers" title="Providers">
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {errand.providers.map((provider) => (
              <ProviderRow key={provider.providerId} provider={provider} />
            ))}
          </ul>
        </Panel>
        <div className="space-y-10">
          <Panel id="missing" title="Missing to close">
            <MissingToClose errand={errand} />
          </Panel>
          <Panel id="ranking" title="Ranked quotes">
            {errand.ranking.length === 0 ? (
              <p className="text-sm text-muted-foreground">No quotes yet.</p>
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableCaption className="sr-only">
                    Quotes ranked eligible first, then by total
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">#</TableHead>
                      <TableHead scope="col">Provider</TableHead>
                      <TableHead scope="col">Evaluation</TableHead>
                      <TableHead scope="col" className="text-right">
                        Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errand.ranking.map((quote, index) => (
                      <TableRow key={quote.providerId}>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {index + 1}
                        </TableCell>
                        <TableHead scope="row" className="font-medium text-foreground">
                          {quote.name}
                        </TableHead>
                        <TableCell>
                          <Badge variant="outline" className={EVALUATIONS[quote.evaluation].tone}>
                            {EVALUATIONS[quote.evaluation].label}
                          </Badge>
                          {quote.unknownCount > 0 ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {quote.unknownCount} unknown
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(quote.total)}
                          {quote.estimated ? (
                            <span className="text-status-warning"> est.</span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </article>
  );
}
