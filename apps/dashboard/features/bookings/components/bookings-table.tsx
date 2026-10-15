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
import { formatInstant, statusLabel } from "@/lib/format.ts";
import type { BookingSummary } from "@/lib/types.ts";

/** Bookings, newest first, cancelled ones included, with their history. */
export function BookingsTable({ bookings }: { readonly bookings: readonly BookingSummary[] }) {
  if (bookings.length === 0) {
    return <EmptyState>No bookings yet. Booker books only within your standing rules.</EmptyState>;
  }
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableCaption className="sr-only">Bookings, newest first</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Provider</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Participants</TableHead>
            <TableHead scope="col">History</TableHead>
            <TableHead scope="col">Booking</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bookings.map((booking) => (
            <TableRow key={booking.id}>
              <TableHead scope="row" className="font-medium text-foreground">
                {booking.providerName ?? booking.providerId}
              </TableHead>
              <TableCell>
                <StatusChip status={booking.status} />
              </TableCell>
              <TableCell>
                {booking.participantIds.length} participant
                {booking.participantIds.length === 1 ? "" : "s"}
              </TableCell>
              <TableCell>
                <ol className="space-y-0.5 text-muted-foreground">
                  {booking.history.map((entry) => (
                    <li key={`${entry.status}-${entry.at}`}>
                      {statusLabel(entry.status)}{" "}
                      <time dateTime={entry.at}>{formatInstant(entry.at)}</time>
                    </li>
                  ))}
                </ol>
              </TableCell>
              <TableCell className="font-mono text-muted-foreground">{booking.id}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
