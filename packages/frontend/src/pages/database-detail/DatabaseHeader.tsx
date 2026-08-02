import {
  EllipsisVertical,
  HardDrive,
  KeyRound,
  Pause,
  Pin,
  Play,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
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
  healthStatus: DatabaseConnection["healthStatus"] | "paused";
  canEdit: boolean;
  canResize: boolean;
  canPause: boolean;
  canUnpause: boolean;
  canRestart: boolean;
  canReveal: boolean;
  canRotateDirectCredentials: boolean;
  canRotateCertificate: boolean;
  canDelete: boolean;
  onOpenPin: () => void;
  onBack: () => void;
  onTest: () => void;
  onOpenSettings: () => void;
  onOpenResize: () => void;
  onPause: () => void;
  onUnpause: () => void;
  onRestart: () => void;
  onRevealCredentials: () => void;
  onRotateDirectCredentials: () => void;
  onRotateCertificate: () => void;
  onRemove: () => void;
}

export function DatabaseHeader({
  database,
  healthStatus,
  canEdit,
  canResize,
  canPause,
  canUnpause,
  canRestart,
  canReveal,
  canRotateDirectCredentials,
  canRotateCertificate,
  canDelete,
  onOpenPin,
  onBack,
  onTest,
  onOpenSettings,
  onOpenResize,
  onPause,
  onUnpause,
  onRestart,
  onRevealCredentials,
  onRotateDirectCredentials,
  onRotateCertificate,
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
      {canResize && (
        <DropdownMenuItem onClick={onOpenResize}>
          <HardDrive className="h-3.5 w-3.5 mr-2" />
          Resize database
        </DropdownMenuItem>
      )}
      {(canPause || canUnpause) && (
        <DropdownMenuItem onClick={canPause ? onPause : onUnpause}>
          {canPause ? (
            <Pause className="h-3.5 w-3.5 mr-2" />
          ) : (
            <Play className="h-3.5 w-3.5 mr-2" />
          )}
          {canPause ? "Pause database" : "Unpause database"}
        </DropdownMenuItem>
      )}
      {canRestart && (
        <DropdownMenuItem onClick={onRestart}>
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
          Restart database
        </DropdownMenuItem>
      )}
      {(canEdit || canPause || canUnpause) && (canReveal || canDelete) && <DropdownMenuSeparator />}
      {canReveal && (
        <DropdownMenuItem onClick={onRevealCredentials}>
          <KeyRound className="h-3.5 w-3.5 mr-2" />
          Reveal credentials
        </DropdownMenuItem>
      )}
      {canRotateDirectCredentials && (
        <DropdownMenuItem onClick={onRotateDirectCredentials}>
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
          Rotate direct-access credentials
        </DropdownMenuItem>
      )}
      {canRotateCertificate && (
        <DropdownMenuItem onClick={onRotateCertificate}>
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
          Rotate TLS certificate
        </DropdownMenuItem>
      )}
      {(canReveal || canRotateDirectCredentials || canRotateCertificate) && canDelete && (
        <DropdownMenuSeparator />
      )}
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
          ...(canPause
            ? [
                {
                  id: "database:pause",
                  label: "Pause database",
                  icon: <Pause className="h-4 w-4" />,
                  action: onPause,
                },
              ]
            : []),
          ...(canUnpause
            ? [
                {
                  id: "database:unpause",
                  label: "Unpause database",
                  icon: <Play className="h-4 w-4" />,
                  action: onUnpause,
                },
              ]
            : []),
          ...(canRestart
            ? [
                {
                  id: "database:restart",
                  label: "Restart database",
                  icon: <RefreshCw className="h-4 w-4" />,
                  action: onRestart,
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
          ...(canRotateDirectCredentials
            ? [
                {
                  id: "database:rotate-direct-credentials",
                  label: "Rotate direct-access credentials",
                  icon: <RefreshCw className="h-4 w-4" />,
                  action: onRotateDirectCredentials,
                },
              ]
            : []),
          ...(canRotateCertificate
            ? [
                {
                  id: "database:rotate-tls-certificate",
                  label: "Rotate TLS certificate",
                  icon: <RefreshCw className="h-4 w-4" />,
                  action: onRotateCertificate,
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
            {database.managed
              ? `Managed ${database.type} ${database.managed.version} · ${database.managed.publishedPort === null ? "private" : `TCP ${database.managed.publishedPort}${database.type === "clickhouse" && database.managed.publishedNativePort != null ? ` · native ${database.managed.publishedNativePort}` : ""}`}`
              : `${database.host}:${database.port}${database.databaseName ? ` · ${database.databaseName}` : ""}`}
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
        {(canEdit ||
          canPause ||
          canUnpause ||
          canRestart ||
          canReveal ||
          canRotateDirectCredentials ||
          canRotateCertificate ||
          canDelete) && (
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
            {(canEdit ||
              canPause ||
              canUnpause ||
              canReveal ||
              canRotateDirectCredentials ||
              canRotateCertificate ||
              canDelete) && <DropdownMenuSeparator />}
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
