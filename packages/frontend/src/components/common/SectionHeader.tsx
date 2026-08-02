import type * as React from "react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  titleClassName?: string;
  descriptionClassName?: string;
  contentClassName?: string;
  actionsClassName?: string;
  withBorder?: boolean;
  wrap?: boolean;
}

export function SectionHeader({
  title,
  description,
  actions,
  children,
  className,
  titleClassName,
  descriptionClassName,
  contentClassName,
  actionsClassName,
  withBorder = true,
  wrap = false,
  ...props
}: SectionHeaderProps) {
  const rightSlot = actions ?? children;

  return (
    <div
      className={cn(
        wrap
          ? "flex flex-wrap items-center justify-between gap-3"
          : "flex items-center justify-between",
        withBorder && "border-b border-border",
        "bg-muted/60 p-4 dark:bg-muted",
        className
      )}
      {...props}
    >
      <div className={cn("min-w-0", contentClassName)}>
        <h3 className={cn("text-sm font-semibold", titleClassName)}>{title}</h3>
        {description ? (
          <p className={cn("text-xs text-muted-foreground", descriptionClassName)}>{description}</p>
        ) : null}
      </div>
      {rightSlot ? (
        <div className={cn("flex shrink-0 items-center gap-2", actionsClassName)}>{rightSlot}</div>
      ) : null}
    </div>
  );
}
