import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2, Plus, RefreshCw } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import {
  SimpleTable,
  type SimpleTableColumn,
  type SimpleTableRowRenderProps,
} from "@/components/common/SimpleTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { InferenceProviderCatalogItem, InferenceProviderConnection } from "@/types/inference";
import { InferenceProviderConnectDialog } from "./InferenceProviderConnectDialog";
import { InferenceProviderDialog } from "./InferenceProviderDialog";
import { connectionIdentity, formatWorstQuota, HealthBadge } from "./inference-provider-ui";

const PROVIDER_CATALOG_CACHE_KEY = "req:/api/inference/providers/catalog";
const PROVIDER_CONNECTIONS_CACHE_KEY = "req:/api/inference/providers/connections";
type ProviderSortable = ReturnType<typeof useSortable>;
const ProviderDragHandleContext = createContext<
  Pick<ProviderSortable, "attributes" | "listeners" | "setActivatorNodeRef"> | undefined
>(undefined);

export function reorderProviderConnections(
  connections: InferenceProviderConnection[],
  activeId: string,
  overId: string
) {
  const oldIndex = connections.findIndex((connection) => connection.id === activeId);
  const newIndex = connections.findIndex((connection) => connection.id === overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return connections;
  return arrayMove(connections, oldIndex, newIndex).map((connection, routingOrder) => ({
    ...connection,
    routingOrder,
  }));
}

export function InferenceProvidersPanel({
  onConnectionsChanged,
  refreshToken = 0,
}: {
  onConnectionsChanged?: () => void;
  refreshToken?: number;
}) {
  const canManage = useAuthStore((state) => state.hasScope("inference:providers:manage"));
  const cachedCatalog = api.getCached<InferenceProviderCatalogItem[]>(
    PROVIDER_CATALOG_CACHE_KEY,
    Number.POSITIVE_INFINITY
  );
  const cachedConnections = api.getCached<InferenceProviderConnection[]>(
    PROVIDER_CONNECTIONS_CACHE_KEY,
    Number.POSITIVE_INFINITY
  );
  const hasCachedData = cachedCatalog !== undefined && cachedConnections !== undefined;
  const [catalog, setCatalog] = useState<InferenceProviderCatalogItem[]>(cachedCatalog ?? []);
  const [connections, setConnections] = useState<InferenceProviderConnection[]>(
    cachedConnections ?? []
  );
  const [loading, setLoading] = useState(!hasCachedData);
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const initializedRef = useRef(hasCachedData);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const providers = useMemo(
    () => new Map(catalog.map((provider) => [provider.id, provider])),
    [catalog]
  );
  const selectedConnection = connections.find((connection) => connection.id === selectedId) ?? null;
  const selectedProvider = selectedConnection
    ? (providers.get(selectedConnection.providerId) ?? null)
    : null;

  const load = useCallback(
    async ({ showLoading = !initializedRef.current }: { showLoading?: boolean } = {}) => {
      if (showLoading) setLoading(true);
      try {
        const [nextCatalog, nextConnections] = await Promise.all([
          api.listInferenceProviderCatalog(),
          api.listInferenceProviderConnections(),
        ]);
        setCatalog(nextCatalog);
        setConnections(nextConnections);
        initializedRef.current = true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load inference providers");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void refreshToken;
    void load();
  }, [load, refreshToken]);

  const changed = async () => {
    await load({ showLoading: false });
    onConnectionsChanged?.();
  };

  const syncConnection = async (connection: InferenceProviderConnection) => {
    setSyncingId(connection.id);
    try {
      await api.syncInferenceProvider(connection.id);
      await changed();
      toast.success("Provider synchronized");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Provider sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const reorderConnections = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reordering) return;
    const previous = connections;
    const next = reorderProviderConnections(previous, String(active.id), String(over.id));
    if (next === previous) return;
    const changedOrders = next.filter(
      (connection) =>
        previous.find((candidate) => candidate.id === connection.id)?.routingOrder !==
        connection.routingOrder
    );
    setConnections(next);
    setReordering(true);
    try {
      const results = await Promise.allSettled(
        changedOrders.map((connection) =>
          api.updateInferenceProvider(connection.id, { routingOrder: connection.routingOrder })
        )
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await changed();
      toast.success("Provider order updated");
    } catch (error) {
      setConnections(previous);
      await load({ showLoading: false });
      toast.error(error instanceof Error ? error.message : "Failed to update provider order");
    } finally {
      setReordering(false);
    }
  };

  const columns: SimpleTableColumn<InferenceProviderConnection>[] = [
    ...(canManage && connections.length > 1
      ? [
          {
            id: "reorder",
            header: <span className="sr-only">Order</span>,
            className: "w-10 pr-0",
            cellClassName: "w-10 pr-0",
            render: (connection: InferenceProviderConnection) => (
              <ProviderDragHandle connection={connection} disabled={reordering} />
            ),
          },
        ]
      : []),
    {
      id: "provider",
      header: "Provider",
      render: (connection) => {
        const provider = providers.get(connection.providerId);
        return (
          <div>
            <p className="font-medium">{provider?.label ?? connection.providerId}</p>
            <p className="text-xs text-muted-foreground">
              {provider?.subscription ? "Subscription" : "API"}
            </p>
          </div>
        );
      },
    },
    {
      id: "account",
      header: "Account / key",
      render: (connection) => (
        <div>
          <p>{connection.name}</p>
          <p className="text-xs text-muted-foreground">{connectionIdentity(connection)}</p>
        </div>
      ),
    },
    {
      id: "health",
      header: "Health",
      render: (connection) => (
        <HealthBadge status={connection.enabled ? connection.status : "disabled"} />
      ),
    },
    {
      id: "quota",
      header: "Quota / balance",
      render: (connection) => formatWorstQuota([connection]),
    },
    {
      id: "sync",
      header: "Last sync",
      render: (connection) =>
        connection.lastSyncedAt ? formatRelativeDate(connection.lastSyncedAt) : "Never",
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      className: "w-20",
      cellClassName: "w-20",
      render: (connection) =>
        canManage ? (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="outline"
              size="icon"
              onClick={() => void syncConnection(connection)}
              disabled={syncingId === connection.id}
              aria-label={`Sync ${connection.name}`}
              title={`Sync ${connection.name}`}
            >
              {syncingId === connection.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      {loading && <Skeleton />}
      <PanelShell
        title="Providers"
        description="Connected accounts and API credentials. Higher connections are used first by Sequential routing; Balanced distributes evenly."
        actions={
          canManage ? (
            <Button onClick={() => setConnectOpen(true)}>
              <Plus />
              Connect provider
            </Button>
          ) : null
        }
      >
        {canManage && connections.length > 1 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => void reorderConnections(event)}
          >
            <SortableContext
              items={connections.map((connection) => connection.id)}
              strategy={verticalListSortingStrategy}
            >
              <SimpleTable
                columns={columns}
                rows={connections}
                getRowKey={(connection) => connection.id}
                loading={loading}
                emptyMessage="No inference providers connected"
                onRowClick={(connection) => setSelectedId(connection.id)}
                rowRenderer={(props) => <SortableProviderRow {...props} />}
                tableClassName="min-w-[900px]"
              />
            </SortableContext>
          </DndContext>
        ) : (
          <SimpleTable
            columns={columns}
            rows={connections}
            getRowKey={(connection) => connection.id}
            loading={loading}
            emptyMessage="No inference providers connected"
            onRowClick={(connection) => setSelectedId(connection.id)}
            tableClassName="min-w-[860px]"
          />
        )}
      </PanelShell>
      <InferenceProviderConnectDialog
        open={connectOpen}
        catalog={catalog}
        onOpenChange={setConnectOpen}
        onConnected={changed}
      />
      <InferenceProviderDialog
        open={selectedConnection !== null}
        connection={selectedConnection}
        provider={selectedProvider}
        canManage={canManage}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onChanged={changed}
      />
    </>
  );
}

function SortableProviderRow({
  row,
  className,
  onClick,
  children,
}: SimpleTableRowRenderProps<InferenceProviderConnection>) {
  const sortable = useSortable({ id: row.id });
  return (
    <ProviderDragHandleContext.Provider
      value={{
        attributes: sortable.attributes,
        listeners: sortable.listeners,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
      }}
    >
      <tr
        ref={sortable.setNodeRef}
        style={{
          transform: CSS.Transform.toString(sortable.transform),
          transition: sortable.transition,
        }}
        className={cn(className, sortable.isDragging && "relative z-10 bg-accent opacity-70")}
        onClick={onClick}
      >
        {children}
      </tr>
    </ProviderDragHandleContext.Provider>
  );
}

function ProviderDragHandle({
  connection,
  disabled,
}: {
  connection: InferenceProviderConnection;
  disabled: boolean;
}) {
  const sortable = useContext(ProviderDragHandleContext);
  if (!sortable) return null;
  return (
    <Button
      ref={sortable.setActivatorNodeRef}
      variant="ghost"
      size="icon"
      className="h-8 w-8 cursor-grab text-muted-foreground active:cursor-grabbing"
      disabled={disabled}
      aria-label={`Reorder ${connection.name}`}
      title={`Reorder ${connection.name}`}
      onClick={(event) => event.stopPropagation()}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripVertical />
    </Button>
  );
}
