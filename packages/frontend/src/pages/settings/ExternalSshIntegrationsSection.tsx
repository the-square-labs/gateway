import { KeyRound, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { ExternalSshConnector } from "@/types/integrations";
import { ExternalSshConnectorDialog } from "./ExternalSshConnectorDialog";

export function ExternalSshIntegrationsSection() {
  const hasScope = useAuthStore((state) => state.hasScope);
  const canManage = hasScope("integrations:ssh:manage");
  const [connectors, setConnectors] = useState<ExternalSshConnector[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setConnectors(await api.listExternalSshConnectors());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load SSH connectors");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <PanelShell
        title="External SSH Integrations"
        description="Encrypted credentials for external servers only. Gateway and managed nodes use their dedicated tools."
        actions={
          canManage ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Connector
            </Button>
          ) : null
        }
      >
        {connectors.length ? (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <div key={connector.id} className="flex items-center gap-3 px-4 py-3">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{connector.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {connector.username}@{connector.host}:{connector.port}
                    {connector.jumpConnectorId ? " via jump host" : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            message="No external SSH connectors configured."
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? () => setOpen(true) : undefined}
            embedded
          />
        )}
      </PanelShell>
      <ExternalSshConnectorDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => {
          setOpen(false);
          void refresh();
        }}
      />
    </>
  );
}
