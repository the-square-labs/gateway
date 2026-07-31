import { EllipsisVertical, KeyRound, Pin, RefreshCw, Settings, Trash2 } from "lucide-react";
import { CommandPalettePageActions } from "@/components/common/CommandPalettePageActions";
import { PageBackButton } from "@/components/common/PageBackButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DatabaseConnection } from "@/types";
import { formatHealthStatusLabel, HEALTH_BADGE } from "./shared";

interface DatabaseHeaderProps {
  database: DatabaseConnection;
  healthStatus: DatabaseConnection["healthStatus"];
  canEdit: boolean;
  canReveal: boolean;
  canDelete: boolean;
  onOpenPin: () => void;
  onBack: () => void;
  onTest: () => void;
  onOpenSettings: () => void;
  onRevealCredentials: () => void;
  onRemove: () => void;
}

export function DatabaseHeader({
  database,
  healthStatus,
  canEdit,
  canReveal,
  canDelete,
  onOpenPin,
  onBack,
  onTest,
  onOpenSettings,
  onRevealCredentials,
  onRemove,
}: DatabaseHeaderProps) {
  const menuItems = (
    <>
      {canEdit && (
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="h-3.5 w-3.5 mr-2" />
          Settings
        </DropdownMenuItem>
      )}
      {canEdit && (canReveal || canDelete) && <DropdownMenuSeparator />}
      {canReveal && (
        <DropdownMenuItem onClick={onRevealCredentials}>
          <KeyRound className="h-3.5 w-3.5 mr-2" />
          Reveal credentials
        </DropdownMenuItem>
      )}
      {canReveal && canDelete && <DropdownMenuSeparator />}
      {canDelete && (
        <DropdownMenuItem onClick={onRemove} className="text-destructive">
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Remove
        </DropdownMenuItem>
      )}
    </>
  );

  return (
    <div className="flex shrink-0 items-center justify-between gap-3">
      <CommandPalettePageActions
        actions={[
          {
            id: "database:pin",
            label: "Pin database",
            icon: <Pin className="h-4 w-4" />,
            action: onOpenPin,
          },
          ...(canEdit
            ? [
                {
                  id: "database:test",
                  label: "Test database connection",
                  icon: <RefreshCw className="h-4 w-4" />,
                  action: onTest,
                },
                {
                  id: "database:settings",
                  label: "Database settings",
                  icon: <Settings className="h-4 w-4" />,
                  action: onOpenSettings,
                },
              ]
            : []),
          ...(canReveal
            ? [
                {
                  id: "database:reveal-credentials",
                  label: "Reveal database credentials",
                  icon: <KeyRound className="h-4 w-4" />,
                  action: onRevealCredentials,
                },
              ]
            : []),
          ...(canDelete
            ? [
                {
                  id: "database:remove",
                  label: "Remove database",
                  icon: <Trash2 className="h-4 w-4" />,
                  action: onRemove,
                },
              ]
            : []),
        ]}
      />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PageBackButton onClick={onBack} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-2xl font-bold">{database.name}</h1>
            <Badge
              variant={HEALTH_BADGE[healthStatus] ?? "secondary"}
              size="inline"
              className="shrink-0"
            >
              {formatHealthStatusLabel(healthStatus)}
            </Badge>
            <Badge variant="secondary" size="inline" className="shrink-0">
              {database.type}
            </Badge>
          </div>
          <p className="break-all text-sm text-muted-foreground">
            {database.host}:{database.port}
            {database.databaseName ? ` · ${database.databaseName}` : ""}
          </p>
        </div>
      </div>

      <div className="hidden items-center gap-2 sm:flex">
        <Button variant="outline" size="icon" onClick={onOpenPin}>
          <Pin className="h-4 w-4" />
        </Button>
        {canEdit && (
          <Button variant="outline" onClick={onTest}>
            <RefreshCw className="h-4 w-4" />
            Test
          </Button>
        )}
        {(canEdit || canReveal || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="ml-auto flex shrink-0 sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Database actions">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpenPin}>
              <Pin className="h-3.5 w-3.5 mr-2" />
              Pin
            </DropdownMenuItem>
            {canEdit && (
              <DropdownMenuItem onClick={onTest}>
                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                Test
              </DropdownMenuItem>
            )}
            {(canEdit || canReveal || canDelete) && <DropdownMenuSeparator />}
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
