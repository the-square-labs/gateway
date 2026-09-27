import type { ReactNode } from "react";
import { type DateInput, formatDateTime, formatRelativeDate, parseDate } from "@/lib/utils";

/**
 * A past event (created, updated, last seen, finished…) as relative time,
 * "3h ago" or "16 Oct 15:32", with the exact moment in the hover title.
 * A missing or invalid value shows `fallback`.
 */
export function RelativeTime({
  value,
  fallback = "—",
  className,
}: {
  value: DateInput;
  fallback?: ReactNode;
  className?: string;
}) {
  const date = parseDate(value);
  if (!date) return <span className={className}>{fallback}</span>;

  return (
    <time dateTime={date.toISOString()} title={formatDateTime(date)} className={className}>
      {formatRelativeDate(date)}
    </time>
  );
}
