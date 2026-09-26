import { Loader2 } from "lucide-react";
import type { ElementType, ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A full-width choice: an icon, a title, a description and an optional
 * trailing element (a status badge or an arrow). Used by the setup checklist,
 * the setup wizards and choice dialogs.
 */
export function ChoiceCard({
  icon: Icon,
  title,
  description,
  trailing,
  pending = false,
  disabled,
  className,
  ...props
}: Omit<ButtonProps, "title" | "children"> & {
  icon: ElementType;
  title: ReactNode;
  description: ReactNode;
  trailing?: ReactNode;
  /** The choice started an action: its icon turns into a spinner. */
  pending?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn("h-auto w-full justify-start whitespace-normal px-4 py-3 text-left", className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      <span className="flex w-full items-center gap-3">
        {pending ? (
          <Loader2 className="shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <Icon className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            {description}
          </span>
        </span>
        {trailing ? <span className="shrink-0">{trailing}</span> : null}
      </span>
    </Button>
  );
}
