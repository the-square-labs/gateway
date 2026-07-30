import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsControlRow({
  title,
  description,
  children,
  className,
  controlsClassName = "",
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  controlsClassName?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(12rem,1fr)_auto] sm:items-center",
        className
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div
        className={cn(
          "flex w-full shrink-0 items-center justify-end sm:w-auto sm:min-w-[14rem] sm:max-w-[24rem]",
          controlsClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function SettingsInlineControl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block w-full min-w-0 space-y-1.5">
      <span className="block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
