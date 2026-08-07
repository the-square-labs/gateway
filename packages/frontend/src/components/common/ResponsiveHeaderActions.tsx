import { EllipsisVertical } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRegisterCommandPalettePageActions } from "@/hooks/use-command-palette-page-actions";

export interface ResponsiveHeaderAction {
  id?: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
}

const MIN_HEADER_CONTENT_WIDTH_PX = 320;

export function shouldCollapseHeaderActions(headerWidth: number, actionsWidth: number): boolean {
  return (
    headerWidth > 0 && actionsWidth > 0 && headerWidth < actionsWidth + MIN_HEADER_CONTENT_WIDTH_PX
  );
}

export function HeaderOverflowMenu({
  actions,
  disabled = false,
  ariaLabel = "More page actions",
}: {
  actions: ResponsiveHeaderAction[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" disabled={disabled} aria-label={ariaLabel}>
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action, index) => (
          <ResponsiveHeaderActionItem
            key={action.id ?? `${action.label}:${index}`}
            action={action}
            showSeparator={index > 0 && action.separatorBefore}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ResponsiveHeaderActions({
  children,
  actions,
  className = "",
}: {
  children: ReactNode;
  actions: ResponsiveHeaderAction[];
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionsWidthRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const actionSignature = actions.map((action) => action.id ?? action.label).join("|");

  useRegisterCommandPalettePageActions(
    actions.map((action, index) => ({
      id:
        action.id ??
        `header:${action.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "action"}:${index}`,
      label: action.label,
      icon: action.icon,
      action: action.onClick,
      disabled: action.disabled,
    }))
  );

  useLayoutEffect(() => {
    if (!actionSignature) return;

    const root = rootRef.current;
    const header = root?.parentElement;
    if (!root || !header) return;

    const updateLayout = () => {
      if (actionsRef.current) {
        actionsWidthRef.current = actionsRef.current.getBoundingClientRect().width;
      }

      const nextCollapsed = shouldCollapseHeaderActions(
        header.getBoundingClientRect().width,
        actionsWidthRef.current
      );
      setCollapsed((current) => (current === nextCollapsed ? current : nextCollapsed));
    };

    updateLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateLayout);
    observer.observe(header);
    return () => observer.disconnect();
  }, [actionSignature]);

  if (actions.length === 0) return null;

  return (
    <div ref={rootRef} className="ml-auto flex shrink-0 self-center">
      {collapsed ? (
        <HeaderOverflowMenu actions={actions} ariaLabel="Page actions" />
      ) : (
        <div ref={actionsRef} className={`flex items-center gap-2 ${className}`}>
          {children}
        </div>
      )}
      {collapsed && (
        <div
          ref={actionsRef}
          aria-hidden="true"
          className="pointer-events-none fixed -left-full top-0 flex w-max items-center gap-2 invisible"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ResponsiveHeaderActionItem({
  action,
  showSeparator = action.separatorBefore,
}: {
  action: ResponsiveHeaderAction;
  showSeparator?: boolean;
}) {
  return (
    <>
      {showSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        disabled={action.disabled}
        title={action.disabled ? action.disabledReason : undefined}
        onClick={action.onClick}
        className={action.destructive ? "text-destructive" : undefined}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </>
  );
}
