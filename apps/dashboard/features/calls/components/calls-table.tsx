import Link from "next/link";
import { EmptyState } from "@/components/empty-state.tsx";
import { StatusChip } from "@/components/status-chip.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInstant } from "@/lib/format.ts";
import type { CallSummary } from "@/lib/types.ts";

function Instant({ iso }: { readonly iso: string | null }) {
  return iso === null ? (
    <span className="text-muted-foreground">-</span>
  ) : (
    <time dateTime={iso}>{formatInstant(iso)}</time>
  );
}

/** Recent calls, newest first, each linking to its detail page. */
export function CallsTable({ calls }: { readonly calls: readonly CallSummary[] }) {
  if (calls.length === 0) {
    return (
      <EmptyState>
        No calls yet. Place one with <code className="font-mono">pnpm booker call</code>.
      </EmptyState>
    );
  }
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableCaption className="sr-only">Recent calls, newest first</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Provider</TableHead>
            <TableHead scope="col">Number</TableHead>
            <TableHead scope="col">Purpose</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Placed</TableHead>
            <TableHead scope="col">Ended</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((call) => (
            <TableRow key={call.callId}>
              <TableHead scope="row" className="font-medium">
                <Link
                  href={`/calls/${encodeURIComponent(call.callId)}`}
                  className="text-foreground no-underline hover:underline"
                >
                  {call.providerName ?? call.providerId}
                </Link>
              </TableHead>
              <TableCell className="font-mono text-muted-foreground">
                {call.providerPhone ?? "-"}
              </TableCell>
              <TableCell>
                {call.purpose}
                {call.attempt > 1 ? ` (attempt ${call.attempt})` : ""}
              </TableCell>
              <TableCell>
                <StatusChip status={call.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                <Instant iso={call.createdAt} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                <Instant iso={call.endedAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
