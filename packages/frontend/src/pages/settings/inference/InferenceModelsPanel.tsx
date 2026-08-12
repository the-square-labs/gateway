import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PermissionGroup, User } from "@/types";
import type {
  InferenceModel,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
} from "@/types/inference";
import { InferenceModelDialog } from "./InferenceModelDialog";

export function InferenceModelsPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const canManage = useAuthStore((state) => state.hasScope("inference:models:manage"));
  const canListGroups = useAuthStore((state) => state.hasScope("admin:groups"));
  const canListUsers = useAuthStore((state) => state.hasScope("admin:users"));
  const cachedModels = api.getCached<InferenceModel[]>(
    "req:/api/inference/models",
    Number.POSITIVE_INFINITY
  );
  const cachedConnections = api.getCached<InferenceProviderConnection[]>(
    "req:/api/inference/providers/connections",
    Number.POSITIVE_INFINITY
  );
  const cachedCatalog = api.getCached<InferenceProviderCatalogItem[]>(
    "req:/api/inference/providers/catalog",
    Number.POSITIVE_INFINITY
  );
  const cachedGroups = canListGroups
    ? api.getCached<PermissionGroup[]>("req:/api/admin/groups", Number.POSITIVE_INFINITY)
    : [];
  const cachedUsers = canListUsers
    ? api.getCached<User[]>("req:/api/admin/users", Number.POSITIVE_INFINITY)
    : [];
  const hasCachedData =
    cachedModels !== undefined &&
    cachedConnections !== undefined &&
    cachedCatalog !== undefined &&
    cachedGroups !== undefined &&
    cachedUsers !== undefined;
  const [models, setModels] = useState<InferenceModel[]>(cachedModels ?? []);
  const [connections, setConnections] = useState<InferenceProviderConnection[]>(
    cachedConnections ?? []
  );
  const [catalog, setCatalog] = useState<InferenceProviderCatalogItem[]>(cachedCatalog ?? []);
  const [groups, setGroups] = useState<PermissionGroup[]>(cachedGroups ?? []);
  const [users, setUsers] = useState<User[]>(cachedUsers ?? []);
  const [loading, setLoading] = useState(!hasCachedData);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InferenceModel | null>(null);
  const initializedRef = useRef(hasCachedData);
  const providerLabels = new Map(catalog.map((provider) => [provider.id, provider.label]));

  const load = useCallback(
    async ({ showLoading = true }: { showLoading?: boolean } = {}) => {
      if (showLoading) setLoading(true);
      try {
        const [nextModels, nextConnections, nextCatalog] = await Promise.all([
          api.listInferenceModels(),
          api.listInferenceProviderConnections(),
          api.listInferenceProviderCatalog(),
        ]);
        setModels(nextModels);
        setConnections(nextConnections);
        setCatalog(nextCatalog);
        const [nextGroups, nextUsers] = await Promise.all([
          canListGroups ? api.listGroups() : Promise.resolve([]),
          canListUsers ? api.listUsers() : Promise.resolve([]),
        ]);
        setGroups(nextGroups);
        setUsers(nextUsers);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load inference models");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [canListGroups, canListUsers]
  );

  useEffect(() => {
    void refreshToken;
    const showLoading = !initializedRef.current;
    initializedRef.current = true;
    void load({ showLoading });
  }, [load, refreshToken]);

  const remove = async (model: InferenceModel) => {
    const accepted = await confirm({
      title: "Delete inference model",
      description: `Delete “${model.displayName}” and its provider configuration?`,
      confirmLabel: "Delete",
    });
    if (!accepted) return;
    try {
      await api.deleteInferenceModel(model.id);
      await load({ showLoading: false });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete model");
    }
  };

  const columns: SimpleTableColumn<InferenceModel>[] = [
    {
      id: "model",
      header: "Model",
      render: (model) => (
        <div>
          <p className="font-medium">{model.displayName}</p>
          <p className="font-mono text-xs text-muted-foreground">{model.publicId}</p>
        </div>
      ),
    },
    {
      id: "provider",
      header: "Provider",
      render: (model) => {
        const source = model.sources[0];
        if (!source) return "Not configured";
        return (
          <div>
            <p>{providerLabels.get(source.providerId) ?? source.providerId}</p>
            <p className="text-xs text-muted-foreground">
              {source.upstreamModelId} · {model.sources.length} account
              {model.sources.length === 1 ? "" : "s"}
            </p>
          </div>
        );
      },
    },
    {
      id: "capabilities",
      header: "Capabilities",
      render: (model) =>
        Object.entries(model.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(", ") || "text",
    },
    {
      id: "access",
      header: "Access",
      render: (model) =>
        model.accessMode === "everyone"
          ? "Everyone"
          : model.accessMode === "disabled"
            ? "Disabled"
            : `${model.accessSubjects.length} selected`,
    },
    {
      id: "billing",
      header: "Billing",
      render: (model) => <span>{model.subscriptionMultiplier}× credits</span>,
    },
    {
      id: "status",
      header: "Status",
      render: (model) => (
        <Badge variant={model.enabled ? "success" : "secondary"} size="inline">
          {model.enabled ? "published" : "disabled"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      render: (model) =>
        canManage ? (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="icon"
              aria-label={`Delete ${model.displayName}`}
              onClick={(event) => {
                event.stopPropagation();
                void remove(model);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      {loading && <Skeleton />}
      <PanelShell
        title="Models"
        description="Models exposed to users and the provider account group serving each model"
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              disabled={!connections.length}
            >
              <Plus className="h-4 w-4" />
              Add model
            </Button>
          ) : null
        }
      >
        <SimpleTable
          columns={columns}
          rows={models}
          getRowKey={(row) => row.id}
          loading={loading}
          emptyMessage={
            connections.length
              ? "No inference models published"
              : "Connect a provider before adding models"
          }
          onRowClick={
            canManage
              ? (model) => {
                  setEditing(model);
                  setDialogOpen(true);
                }
              : undefined
          }
        />
      </PanelShell>
      <InferenceModelDialog
        open={dialogOpen}
        editing={editing}
        connections={connections}
        catalog={catalog}
        groups={groups}
        users={users}
        onOpenChange={setDialogOpen}
        onSaved={() => load({ showLoading: false })}
      />
    </>
  );
}
