import { Badge } from "@/components/ui/badge";
import type { ErrandCounts } from "@/lib/errands.ts";

const CHIPS: readonly (readonly [keyof ErrandCounts, string, string])[] = [
  ["calling", "calling", "border-status-active/40 text-status-active"],
  ["quoted", "quoted", "border-status-success/40 text-status-success"],
  ["declined", "declined", "border-status-danger/40 text-status-danger"],
  ["ruledOut", "ruled out", "border-status-warning/50 text-status-warning"],
  ["noAnswer", "no answer", "border-status-warning/50 text-status-warning"],
  ["noQuote", "no quote", "text-muted-foreground"],
  ["failed", "failed", "border-status-danger/40 text-status-danger"],
  ["pending", "pending", "text-muted-foreground"],
];

/** One small chip per outcome that has any providers, such as "2 calling". */
export function CountChips({ counts }: { readonly counts: ErrandCounts }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {CHIPS.filter(([key]) => counts[key] > 0).map(([key, label, tone]) => (
        <li key={key}>
          <Badge variant="outline" className={`px-1.5 py-0 text-[11px] font-medium ${tone}`}>
            {counts[key]} {label}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
