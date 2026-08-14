import type { ReactNode } from "react";
import { CopyButton } from "@/components/common/CopyButton";
import { cn } from "@/lib/utils";

interface CopyValueFieldProps {
  label: string;
  showLabel?: boolean;
  value: string;
  copyValue?: string;
  copyable?: boolean;
  className?: string;
  valueClassName?: string;
  actions?: ReactNode;
}

export function CopyValueField({
  label,
  showLabel = true,
  value,
  copyValue = value,
  copyable = true,
  className,
  valueClassName,
  actions,
}: CopyValueFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel ? <p className="text-xs text-muted-foreground">{label}</p> : null}
      <div className="flex min-w-0 border border-input bg-background">
        <div
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center px-3 text-sm text-foreground",
            valueClassName
          )}
          title={value}
        >
          <span className="truncate">{value}</span>
        </div>
        {copyable && (
          <CopyButton
            value={copyValue}
            label={label}
            className="relative h-9 w-9 shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
            iconClassName="h-3.5 w-3.5"
          />
        )}
        {actions}
      </div>
    </div>
  );
}
