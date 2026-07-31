import { EllipsisVertical } from "lucide-react";
import type { ReactNode } from "react";
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

export function ResponsiveHeaderActions({
  children,
  actions,
  className = "",
}: {
  children: ReactNode;
  actions: ResponsiveHeaderAction[];
  className?: string;
}) {
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

  if (actions.length === 0) return null;

  return (
    <>
      <div className={`hidden items-center gap-2 sm:flex ${className}`}>{children}</div>
      <div className="ml-auto flex shrink-0 self-center sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Page actions">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.map((action) => (
              <ResponsiveHeaderActionItem key={action.label} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

function ResponsiveHeaderActionItem({ action }: { action: ResponsiveHeaderAction }) {
  return (
    <>
      {action.separatorBefore ? <DropdownMenuSeparator /> : null}
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
