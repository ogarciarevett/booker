/** `done` of `total` as a thin bar, readable by screen readers as a progress bar. */
export function ProgressBar({
  done,
  total,
  label,
}: {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </div>
  );
}
