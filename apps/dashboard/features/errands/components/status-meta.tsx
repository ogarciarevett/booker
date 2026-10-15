import {
  Archive,
  Ban,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleQuestionMark,
  CircleX,
  type LucideIcon,
  PhoneCall,
  PhoneMissed,
  PhoneOutgoing,
  TriangleAlert,
} from "lucide-react";
import type { ErrandStage, ProviderStatus } from "@/lib/errands.ts";
import { cn } from "@/lib/utils";

interface StatusMeta {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tone: string;
}

/** For a stage or status this dashboard does not know: neutral, and saying so. */
const UNKNOWN: StatusMeta = {
  label: "Unknown",
  icon: CircleQuestionMark,
  tone: "text-status-neutral",
};

/** Known stages in the order the board shows them: where work is happening first. */
export const STAGE_ORDER: readonly Exclude<ErrandStage, "unknown">[] = [
  "calling",
  "waiting_for_you",
  "preparing",
  "booked",
  "closed",
];

export const STAGES: Readonly<Record<ErrandStage, StatusMeta>> = {
  calling: { label: "Calling", icon: PhoneOutgoing, tone: "text-status-active" },
  waiting_for_you: { label: "Waiting for you", icon: CircleDot, tone: "text-status-warning" },
  preparing: { label: "Preparing", icon: CircleDashed, tone: "text-status-neutral" },
  booked: { label: "Booked", icon: CircleCheckBig, tone: "text-status-success" },
  closed: { label: "Closed", icon: Archive, tone: "text-status-neutral" },
  unknown: UNKNOWN,
};

export const PROVIDER_STATUSES: Readonly<Record<ProviderStatus, StatusMeta>> = {
  not_called: { label: "Not called", icon: CircleDashed, tone: "text-status-neutral" },
  calling: { label: "Calling", icon: PhoneCall, tone: "text-status-active" },
  quoted: { label: "Quoted", icon: CircleCheck, tone: "text-status-success" },
  declined_by_provider: {
    label: "Declined by provider",
    icon: CircleX,
    tone: "text-status-danger",
  },
  ruled_out_by_rules: { label: "Ruled out by rules", icon: Ban, tone: "text-status-warning" },
  no_answer: { label: "No answer", icon: PhoneMissed, tone: "text-status-warning" },
  no_quote: { label: "No quote", icon: CircleMinus, tone: "text-status-neutral" },
  failed: { label: "Failed", icon: TriangleAlert, tone: "text-status-danger" },
  unknown: UNKNOWN,
};

/** A status icon; the label beside it always says the status in words. */
export function StatusIcon({
  meta,
  className,
}: {
  readonly meta: StatusMeta;
  readonly className?: string;
}) {
  const Icon = meta.icon;
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", meta.tone, className)} />;
}
