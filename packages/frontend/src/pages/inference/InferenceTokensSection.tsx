import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyValueField } from "@/components/common/CopyValueField";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDate, formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { inferenceTokenChangedChannel } from "@/services/user-resource-events";
import { useAuthStore } from "@/stores/auth";
import type { InferenceToken } from "@/types/inference";

export function InferenceTokensSection({ canManage }: { canManage: boolean }) {
  const userId = useAuthStore((state) => state.user?.id);
  const [tokens, setTokens] = useState<InferenceToken[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoading = useInitialLoading(loading);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listInferenceTokens();
      setTokens(result.filter((token) => token.status === "active"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load inference tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);
  useRealtime(userId ? inferenceTokenChangedChannel(userId) : null, () => void load(), {
    onReconnect: load,
  });

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await api.createInferenceToken(name.trim());
      setSecret(result.token);
      setSecretOpen(true);
      setCreateOpen(false);
      setName("");
      await load();
      toast.success("Inference token created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create inference token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: InferenceToken) => {
    const accepted = await confirm({
      title: "Revoke inference token",
      description: `Revoke “${token.name}”? Clients using it will lose access immediately.`,
      confirmLabel: "Revoke",
    });
    if (!accepted) return;
    try {
      await api.revokeInferenceToken(token.id);
      await load();
      toast.success("Inference token revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke inference token");
    }
  };

  return (
    <>
      <PanelShell
        title="Inference API Tokens"
        description="Use the Gateway inference base URL with a dedicated gwi_ credential."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create Token
            </Button>
          ) : null
        }
      >
        {initialLoading ? (
          <InferenceTokenRowsSkeleton />
        ) : tokens.length === 0 ? (
          <EmptyState
            message={
              canManage
                ? "No inference API tokens created yet."
                : "No inference API tokens available."
            }
            {...(canManage
              ? { actionLabel: "Create one", onAction: () => setCreateOpen(true) }
              : {})}
            embedded
          />
        ) : (
          <div className="divide-y divide-border">
            {tokens.map((token) => (
              <div
                key={token.id}
                className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50 sm:gap-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{token.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{token.tokenPrefix}...</span>
                      {` · Created ${formatDate(token.createdAt)}`}
                      {token.lastUsedAt
                        ? ` · Last used ${formatRelativeDate(token.lastUsedAt)}`
                        : " · Never used"}
                    </p>
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => void revoke(token)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelShell>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create inference token</DialogTitle>
            <DialogDescription>The token will be shown once after creation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="inference-token-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="inference-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g., Codex on MacBook"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim() || creating}>
              {creating ? "Creating..." : "Create token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secretOpen} onOpenChange={setSecretOpen}>
        <DialogContent
          className="sm:max-w-lg"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              setSecret(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Inference token created</DialogTitle>
            <DialogDescription>Copy this token now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          {secret && (
            <CopyValueField label="Inference token" value={secret} valueClassName="font-mono" />
          )}
          <DialogFooter>
            <Button onClick={() => setSecretOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InferenceTokenRowsSkeleton() {
  return (
    <div className="divide-y divide-border" aria-label="Loading inference API tokens">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-3 p-4 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-10 w-10 shrink-0" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-56 max-w-[60vw]" />
            </div>
          </div>
          <Skeleton className="h-9 w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}
