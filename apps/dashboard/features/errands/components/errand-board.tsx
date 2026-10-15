import { ArrowRight, CircleCheckBig, CircleDot, PhoneOutgoing } from "lucide-react";
import Link from "next/link";
import { ProgressBar } from "@/components/progress-bar.tsx";
import type { ErrandStage, ErrandSummary } from "@/lib/errands.ts";
import { formatInstant } from "@/lib/format.ts";
import { CountChips } from "./count-chips.tsx";
import { STAGE_ORDER, STAGES, StatusIcon } from "./status-meta.tsx";

function ErrandRow({ errand }: { readonly errand: ErrandSummary }) {
  return (
    <li>
      <Link
        href={`/errands/${encodeURIComponent(errand.errandId)}`}
        data-board-row=""
        className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-5 text-foreground no-underline transition-colors outline-none hover:bg-accent/60 focus-visible:bg-accent md:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)_8rem_7rem]"
      >
        <span role="img" aria-label={`Stage: ${STAGES[errand.stage].label}`}>
          <StatusIcon meta={STAGES[errand.stage]} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-relaxed">{errand.objective}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {errand.kind.replaceAll("-", " ")}
          </span>
        </span>
        <span className="col-start-2 md:col-start-auto">
          <CountChips counts={errand.counts} />
        </span>
        <span className="col-start-2 flex items-center gap-2 md:col-start-auto">
          <ProgressBar
            done={errand.progress.done}
            total={errand.progress.total}
            label={`${errand.progress.done} of ${errand.progress.total} providers settled`}
          />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {errand.progress.done}/{errand.progress.total}
          </span>
        </span>
        <span className="col-start-2 text-xs text-muted-foreground md:col-start-auto md:text-right">
          {errand.lastActivityAt === null ? (
            "No activity"
          ) : (
            <time dateTime={errand.lastActivityAt}>{formatInstant(errand.lastActivityAt)}</time>
          )}
        </span>
      </Link>
    </li>
  );
}

/** One group per known stage, in board order, then "Other" for any stage this dashboard does not know. */
const STAGE_GUIDANCE: Readonly<Record<ErrandStage, string>> = {
  calling: "Collecting quotes from your chosen providers.",
  waiting_for_you: "Review the open questions before moving forward.",
  preparing: "The brief is being prepared for the first call.",
  booked: "Check the confirmation and any remaining steps.",
  closed: "Finished errands, kept here for reference.",
  unknown: "Open the errand to review its current state.",
};

const GROUPS: readonly {
  readonly id: string;
  readonly label: string;
  readonly stages: readonly ErrandStage[];
}[] = [
  ...STAGE_ORDER.map((stage) => ({ id: stage, label: STAGES[stage].label, stages: [stage] })),
  { id: "other", label: "Other", stages: ["unknown"] },
];

/**
 * Errands grouped by stage, where work is happening first, as compact rows: a stage icon, the
 * objective, a chip per provider outcome, and how many providers are settled.
 */
export function ErrandBoard({ errands }: { readonly errands: readonly ErrandSummary[] }) {
  const summary = [
    {
      label: "In progress",
      count: errands.filter((errand) => ["calling", "preparing"].includes(errand.stage)).length,
      description: "Preparing briefs and collecting quotes",
      icon: PhoneOutgoing,
      tone: "text-status-active",
    },
    {
      label: "Needs your attention",
      count: errands.filter((errand) => errand.stage === "waiting_for_you").length,
      description: "Open questions to review before the next step",
      icon: CircleDot,
      tone: "text-status-warning",
    },
    {
      label: "Booked",
      count: errands.filter((errand) => errand.stage === "booked").length,
      description: "Reservations with confirmation to check",
      icon: CircleCheckBig,
      tone: "text-status-success",
    },
  ];
  if (errands.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center sm:p-12">
        <PhoneOutgoing aria-hidden="true" className="mx-auto mb-4 size-8 text-primary" />
        <h2 className="text-lg font-semibold">No errands yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Choose your providers and prepare a brief. Once the first call is placed, track its quotes
          and next steps here.
        </p>
        <Link
          href="/settings"
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground no-underline"
        >
          Review settings <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
        <p className="mt-5 text-xs text-muted-foreground">
          Quotes first. A booking needs permission.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-8">
      <dl aria-label="Errand summary" className="grid gap-3 sm:grid-cols-3">
        {summary.map(({ label, count, description, icon: Icon, tone }) => (
          <div key={label} className="relative rounded-xl border bg-card p-5 shadow-sm">
            <Icon aria-hidden="true" className={`absolute top-5 right-5 size-5 ${tone}`} />
            <dt className="pr-7 text-sm font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{count}</dd>
            <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</dd>
          </div>
        ))}
      </dl>
      {GROUPS.map((group) => {
        const inGroup = errands.filter((errand) => group.stages.includes(errand.stage));
        if (inGroup.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`stage-${group.id}`} className="space-y-2">
            <h2
              id={`stage-${group.id}`}
              className="flex items-center gap-2 px-1 text-sm font-semibold"
            >
              <StatusIcon meta={STAGES[group.stages[0] ?? "unknown"]} />
              <span>{group.label}</span>
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {inGroup.length}
              </span>
            </h2>
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">
              {STAGE_GUIDANCE[group.stages[0] ?? "unknown"]}
            </p>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
              {inGroup.map((errand) => (
                <ErrandRow key={errand.errandId} errand={errand} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
