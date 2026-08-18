import { Copy, Key, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDate, formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { LoggingEnvironment, LoggingIngestToken } from "@/types";

export function LoggingTokenPanel({
  environment,
  canDelete,
  createDialogOpen,
  onCreateDialogOpenChange,
}: {
  environment: LoggingEnvironment;
  canDelete: boolean;
  createDialogOpen: boolean;
  onCreateDialogOpenChange: (open: boolean) => void;
}) {
  const [tokens, setTokens] = useState<LoggingIngestToken[]>([]);
  const [name, setName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listLoggingTokens(environment.id)
      .then(setTokens)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load tokens")
      );
  }, [environment.id]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    try {
      const token = await api.createLoggingToken(environment.id, { name });
      setCreatedToken(token.token ?? null);
      setName("");
      load();
    } catch (error) {
      if (!handleLicenseApiError(error, "Logging ingest tokens")) {
        toast.error(error instanceof Error ? error.message : "Failed to create token");
      }
    }
  };

  const setCreateDialogOpen = (nextOpen: boolean) => {
    onCreateDialogOpenChange(nextOpen);
    if (!nextOpen) {
      setCreatedToken(null);
      setName("");
    }
  };

  const revoke = async (token: LoggingIngestToken) => {
    if (
      !(await confirm({
        title: "Revoke ingest token",
        description: `Revoke ${token.name}? Services using this token will stop ingesting logs.`,
        confirmLabel: "Revoke",
      }))
    ) {
      return;
    }
    await api.deleteLoggingToken(environment.id, token.id);
    load();
  };

  return (
    <>
      <PanelShell title="Ingest Tokens" description="Write-only tokens for external services">
        {tokens.length > 0 ? (
          <div className="divide-y divide-border">
            {tokens.map((token) => (
              <div key={token.id} className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                    <Key className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{token.name}</p>
                      <Badge variant={token.enabled ? "success" : "secondary"} size="inline">
                        {token.enabled ? "ENABLED" : "DISABLED"}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {token.tokenPrefix}... &middot; Created {formatDate(token.createdAt)}
                      {token.lastUsedAt
                        ? ` · Last used ${formatRelativeDate(token.lastUsedAt)}`
                        : " · Never used"}
                    </p>
                  </div>
                </div>
                {canDelete && (
                  <Button variant="outline" size="icon" onClick={() => void revoke(token)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState message="No ingest tokens created yet" embedded />
        )}
      </PanelShell>
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Ingest Token</DialogTitle>
            <DialogDescription>Generate a write-only token for this environment.</DialogDescription>
          </DialogHeader>
          {createdToken ? (
            <div className="min-w-0 space-y-3">
              <p className="text-sm text-muted-foreground">This token is shown once.</p>
              <div className="flex max-w-full min-w-0 items-stretch overflow-hidden border border-border">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3 py-2 font-mono text-xs">
                  {createdToken}
                </code>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-auto shrink-0 rounded-none border-y-0 border-r-0"
                  onClick={() => void navigator.clipboard.writeText(createdToken)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateDialogOpen(false);
              }}
            >
              Close
            </Button>
            {!createdToken && (
              <Button disabled={!name.trim()} onClick={() => void create()}>
                Create
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
