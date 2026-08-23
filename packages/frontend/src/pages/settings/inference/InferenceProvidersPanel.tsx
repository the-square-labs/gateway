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
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Folder,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
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

interface ProviderGroupRow {
  kind: "group";
  id: string;
  providerId: string;
  connections: InferenceProviderConnection[];
}

interface ProviderConnectionRow {
  kind: "connection";
  id: string;
  connection: InferenceProviderConnection;
  grouped: boolean;
}

type ProviderTableRow = ProviderGroupRow | ProviderConnectionRow;

export function reorderProviderConnections(
  connections: InferenceProviderConnection[],
  activeId: string,
  overId: string
) {
  const active = connections.find((connection) => connection.id === activeId);
  const over = connections.find((connection) => connection.id === overId);
  if (!active || !over || active.providerId !== over.providerId || active.id === over.id) {
    return connections;
  }
  const siblings = connections.filter((connection) => connection.providerId === active.providerId);
  const oldIndex = siblings.findIndex((connection) => connection.id === activeId);
  const newIndex = siblings.findIndex((connection) => connection.id === overId);
  if (oldIndex < 0 || newIndex < 0) return connections;
  const reordered = arrayMove(siblings, oldIndex, newIndex).map((connection, routingOrder) => ({
    ...connection,
    routingOrder,
  }));
  let siblingIndex = 0;
  return connections.map((connection) =>
    connection.providerId === active.providerId ? reordered[siblingIndex++]! : connection
  );
}

export function groupProviderConnections(
  connections: InferenceProviderConnection[],
  collapsedProviderIds: ReadonlySet<string> = new Set()
): ProviderTableRow[] {
  const groups = new Map<string, InferenceProviderConnection[]>();
  for (const connection of connections) {
    groups.set(connection.providerId, [...(groups.get(connection.providerId) ?? []), connection]);
  }
  return [...groups.entries()].flatMap(([providerId, providerConnections]) => {
    if (providerConnections.length === 1) {
      const connection = providerConnections[0]!;
      return [{ kind: "connection", id: connection.id, connection, grouped: false }];
    }
    const group: ProviderGroupRow = {
      kind: "group",
      id: `provider-group:${providerId}`,
      providerId,
      connections: providerConnections,
    };
    if (collapsedProviderIds.has(providerId)) return [group];
    return [
      group,
      ...providerConnections.map(
        (connection): ProviderConnectionRow => ({
          kind: "connection",
          id: connection.id,
          connection,
          grouped: true,
        })
      ),
    ];
  });
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
  const [collapsedProviderIds, setCollapsedProviderIds] = useState<Set<string>>(() => new Set());
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
  const rows = useMemo(
    () => groupProviderConnections(connections, collapsedProviderIds),
    [collapsedProviderIds, connections]
  );
  const sortableConnectionIds = rows.flatMap((row) =>
    row.kind === "connection" && row.grouped ? [row.id] : []
  );
  const hasReorderableGroups = connections.some(
    (connection, index) =>
      connections.findIndex((candidate) => candidate.providerId === connection.providerId) !== index
  );

  const toggleProviderGroup = (providerId: string) => {
    setCollapsedProviderIds((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

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

  const connected = async () => {
    // The settings page owns the controlled dialog state. Close it before the
    // background catalog refresh so a successful connection cannot leave the
    // reset form visible while provider data is reloaded.
    setConnectOpen(false);
    await changed();
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

  const columns: SimpleTableColumn<ProviderTableRow>[] = [
    ...(canManage && hasReorderableGroups
      ? [
          {
            id: "reorder",
            header: <span className="sr-only">Order</span>,
            className: "w-10 pr-0",
            cellClassName: "w-10 pr-0",
            render: (row: ProviderTableRow) =>
              row.kind === "connection" && row.grouped ? (
                <ProviderDragHandle connection={row.connection} disabled={reordering} />
              ) : null,
          },
        ]
      : []),
    {
      id: "provider",
      header: "Provider",
      render: (row) => {
        if (row.kind === "group") {
          const provider = providers.get(row.providerId);
          const collapsed = collapsedProviderIds.has(row.providerId);
          const label = provider?.label ?? row.providerId;
          return (
            <Button
              variant="ghost"
              className="h-auto max-w-full justify-start gap-2 p-0 font-normal hover:bg-transparent"
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleProviderGroup(row.providerId);
              }}
            >
              {collapsed ? <ChevronRight /> : <ChevronDown />}
              <Folder />
              <span className="truncate font-medium">{label}</span>
              <Badge variant="secondary" size="inline">
                {row.connections.length}
              </Badge>
            </Button>
          );
        }
        if (row.grouped) {
          return (
            <span className="flex pl-6 text-muted-foreground" aria-hidden="true">
              <CornerDownRight className="h-4 w-4" />
            </span>
          );
        }
        const provider = providers.get(row.connection.providerId);
        return (
          <div>
            <p className="font-medium">{provider?.label ?? row.connection.providerId}</p>
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
      render: (row) =>
        row.kind === "connection" ? (
          <div>
            <p>{row.connection.name}</p>
            <p className="text-xs text-muted-foreground">{connectionIdentity(row.connection)}</p>
          </div>
        ) : null,
    },
    {
      id: "health",
      header: "Health",
      render: (row) =>
        row.kind === "connection" ? (
          <HealthBadge status={row.connection.enabled ? row.connection.status : "disabled"} />
        ) : null,
    },
    {
      id: "quota",
      header: "Quota / balance",
      render: (row) => (row.kind === "connection" ? formatWorstQuota([row.connection]) : null),
    },
    {
      id: "sync",
      header: "Last sync",
      render: (row) =>
        row.kind === "connection"
          ? row.connection.lastSyncedAt
            ? formatRelativeDate(row.connection.lastSyncedAt)
            : "Never"
          : null,
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      className: "w-20",
      cellClassName: "w-20",
      render: (row) =>
        canManage && row.kind === "connection" ? (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="outline"
              size="icon"
              onClick={() => void syncConnection(row.connection)}
              disabled={syncingId === row.connection.id}
              aria-label={`Sync ${row.connection.name}`}
              title={`Sync ${row.connection.name}`}
            >
              {syncingId === row.connection.id ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
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
        {canManage && hasReorderableGroups ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => void reorderConnections(event)}
          >
            <SortableContext items={sortableConnectionIds} strategy={verticalListSortingStrategy}>
              <SimpleTable
                columns={columns}
                rows={rows}
                getRowKey={(row) => row.id}
                loading={loading}
                emptyMessage="No inference providers connected"
                onRowClick={(row) => {
                  if (row.kind === "group") toggleProviderGroup(row.providerId);
                  else setSelectedId(row.connection.id);
                }}
                rowClassName={(row) =>
                  row.kind === "group" ? "bg-muted/40" : row.grouped ? "bg-card" : undefined
                }
                rowRenderer={(props) => (
                  <ProviderTableRowRenderer {...props} disabled={reordering} />
                )}
                tableClassName="min-w-[900px]"
              />
            </SortableContext>
          </DndContext>
        ) : (
          <SimpleTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            loading={loading}
            emptyMessage="No inference providers connected"
            onRowClick={(row) => {
              if (row.kind === "group") toggleProviderGroup(row.providerId);
              else setSelectedId(row.connection.id);
            }}
            rowClassName={(row) => (row.kind === "group" ? "bg-muted/40" : undefined)}
            tableClassName="min-w-[860px]"
          />
        )}
      </PanelShell>
      <InferenceProviderConnectDialog
        open={connectOpen}
        catalog={catalog}
        onOpenChange={setConnectOpen}
        onConnected={connected}
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

function ProviderTableRowRenderer({
  row,
  className,
  onClick,
  children,
  disabled,
}: SimpleTableRowRenderProps<ProviderTableRow> & { disabled: boolean }) {
  if (row.kind !== "connection" || !row.grouped) {
    return (
      <tr className={className} onClick={onClick}>
        {children}
      </tr>
    );
  }
  return (
    <SortableProviderRow row={row} className={className} onClick={onClick} disabled={disabled}>
      {children}
    </SortableProviderRow>
  );
}

function SortableProviderRow({
  row,
  className,
  onClick,
  children,
  disabled,
}: Omit<SimpleTableRowRenderProps<ProviderConnectionRow>, "index" | "interactive"> & {
  disabled: boolean;
}) {
  const sortable = useSortable({
    id: row.id,
    disabled,
    data: { providerId: row.connection.providerId },
  });
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
        className={cn(
          className,
          "touch-none cursor-grab active:cursor-grabbing",
          sortable.isDragging && "relative z-10 bg-accent opacity-70"
        )}
        onClick={onClick}
        {...sortable.attributes}
        {...sortable.listeners}
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
