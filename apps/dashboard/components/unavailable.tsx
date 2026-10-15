import { CircleAlert } from "lucide-react";

/** Why there is nothing to show, in the owner's terms. */
export function Unavailable({ message }: { readonly message: string }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-dashed bg-card p-5">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Booker's data is not available</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
