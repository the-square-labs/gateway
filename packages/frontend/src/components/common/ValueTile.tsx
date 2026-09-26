import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A bordered tile with a muted label above a monospace value, used in detail
 * dialogs (audit entries, SIEM deliveries, log events). An empty value shows
 * "-". A plain-text value is truncated and gets a hover title; `wrap` breaks
 * long values instead of truncating them.
 */
export function ValueTile({
  label,
  children,
  wrap = false,
  className,
}: {
  label: ReactNode;
  children?: ReactNode;
  wrap?: boolean;
  className?: string;
}) {
  const value = children === null || children === undefined || children === "" ? "-" : children;
  const title = typeof value === "string" ? value : undefined;

  return (
    <div
      data-slot="value-tile"
      className={cn("min-w-0 rounded-md border border-border p-3", className)}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className={cn("font-mono text-xs", wrap ? "break-all" : "truncate")} title={title}>
        {value}
      </div>
    </div>
  );
}
