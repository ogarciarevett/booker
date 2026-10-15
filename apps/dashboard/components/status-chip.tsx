import { Badge } from "@/components/ui/badge";
import { statusLabel, statusTone } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

const DOT: Readonly<Record<ReturnType<typeof statusTone>, string>> = {
  active: "bg-status-active",
  ok: "bg-status-success",
  bad: "bg-status-danger",
  muted: "bg-status-neutral",
};

/** A status as a dot and its name in words, so color is never the only cue. */
export function StatusChip({ status }: { readonly status: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium text-foreground">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[statusTone(status)])} />
      {statusLabel(status)}
    </Badge>
  );
}
