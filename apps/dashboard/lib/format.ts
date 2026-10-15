// Formatting shared by the server-rendered views; no data access here.

const STATUS_LABELS: Readonly<Record<string, string>> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  no_answer: "No answer",
  cancelled: "Cancelled",
  verbal: "Verbal",
  written: "Written",
  enrolled: "Enrolled",
};

/** A call or booking status in words, such as `In progress`. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

/** How a status chip is colored; its text always says the status too. */
export function statusTone(status: string): "active" | "ok" | "bad" | "muted" {
  if (status === "scheduled" || status === "in_progress") return "active";
  if (
    status === "completed" ||
    status === "verbal" ||
    status === "written" ||
    status === "enrolled"
  ) {
    return "ok";
  }
  if (status === "failed") return "bad";
  return "muted";
}

const instantFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** An ISO instant as `6 Oct, 10:00:05` in this machine's time zone. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : instantFormat.format(date);
}

/** Seconds into a call as `m:ss`. */
export function formatOffset(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appliesTo(value: unknown): string | undefined {
  if (value === "each-participant") return "each participant";
  if (value === "group") return "for the group";
  if (isRecord(value) && Array.isArray(value["participantIds"])) {
    return `for ${value["participantIds"].length} participant(s)`;
  }
  return undefined;
}

/**
 * A recorded value as the owner reads it: money as `550.00 EUR` (with who it applies to, and
 * `discount` when it is one), dates as `start to end`, flags as yes or no.
 */
export function formatValue(value: unknown): string {
  if (
    isRecord(value) &&
    typeof value["amountCents"] === "number" &&
    typeof value["currency"] === "string"
  ) {
    const amount = `${(value["amountCents"] / 100).toFixed(2)} ${value["currency"]}`;
    const parts = [value["kind"] === "discount" ? `discount of ${amount}` : amount];
    const who = appliesTo(value["appliesTo"]);
    if (who !== undefined) parts.push(who);
    return parts.join(" ");
  }
  if (isRecord(value) && typeof value["start"] === "string" && typeof value["end"] === "string") {
    return `${value["start"]} to ${value["end"]}`;
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** A configured secret as the owner sees it: "Configured · ends in …1234", never more. */
export function secretSummary(lastFour: string | undefined): string {
  return lastFour === undefined ? "Configured" : `Configured · ends in …${lastFour}`;
}

const amountFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Money as `1,100.00 EUR`. */
export function formatMoney(money: {
  readonly amountCents: number;
  readonly currency: string;
}): string {
  return `${amountFormat.format(money.amountCents / 100)} ${money.currency}`;
}
