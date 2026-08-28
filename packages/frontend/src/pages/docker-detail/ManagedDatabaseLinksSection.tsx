import { AnimatePresence, motion } from "framer-motion";
import { Link2, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { api } from "@/services/api";
import type {
  DatabaseType,
  ManagedDatabase,
  ManagedDatabaseBinding,
  ManagedDatabaseBindingEnvironment,
  ManagedDatabaseBindingTargetType,
  Node,
} from "@/types";

type ConnectionMode = "uri" | "credentials";

interface PendingDatabaseLink {
  id: string;
  managedDatabaseId: string;
  targetResourceId: string;
  environment: ManagedDatabaseBindingEnvironment;
  replacesExistingEnvironment: boolean;
  replacesBindingId?: string;
}

interface PendingDatabaseLinkChanges {
  additions: PendingDatabaseLink[];
  removals: string[];
}

interface DisplayBinding {
  binding: ManagedDatabaseBinding;
  pending: "add" | "remove" | null;
}

export interface ManagedDatabaseLinksSectionHandle {
  applyChanges(options?: {
    replaceExistingEnvironment?: boolean;
    targetEnvironment?: Record<string, string>;
  }): Promise<void>;
}

export interface ManagedDatabaseLinkDraft {
  hasChanges: boolean;
  managedVariableNames: string[];
  pendingAdditionVariableNames: string[];
  replacementVariableNames: string[];
}

const EMPTY_CHANGES: PendingDatabaseLinkChanges = { additions: [], removals: [] };
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

const CREDENTIAL_VARIABLES: Record<
  DatabaseType,
  Array<{ field: keyof ManagedDatabaseBindingEnvironment; label: string; value: string }>
> = {
  postgres: [
    { field: "host", label: "Host variable", value: "POSTGRES_HOST" },
    { field: "port", label: "Port variable", value: "POSTGRES_PORT" },
    { field: "database", label: "Database variable", value: "POSTGRES_DB" },
    { field: "username", label: "Username variable", value: "POSTGRES_USER" },
    { field: "password", label: "Password variable", value: "POSTGRES_PASSWORD" },
  ],
  redis: [
    { field: "host", label: "Host variable", value: "REDIS_HOST" },
    { field: "port", label: "Port variable", value: "REDIS_PORT" },
    { field: "username", label: "Username variable", value: "REDIS_USERNAME" },
    { field: "password", label: "Password variable", value: "REDIS_PASSWORD" },
  ],
  clickhouse: [
    { field: "host", label: "Host variable", value: "CLICKHOUSE_HOST" },
    { field: "port", label: "Port variable", value: "CLICKHOUSE_PORT" },
    { field: "database", label: "Database variable", value: "CLICKHOUSE_DATABASE" },
    { field: "username", label: "Username variable", value: "CLICKHOUSE_USER" },
    { field: "password", label: "Password variable", value: "CLICKHOUSE_PASSWORD" },
  ],
};

function defaultEnvironment(database: ManagedDatabase | undefined, mode: ConnectionMode) {
  if (mode === "uri") {
    return { connectionUri: database?.type === "redis" ? "REDIS_URL" : "DATABASE_URL" };
  }
  if (!database) return {};
  return Object.fromEntries(
    CREDENTIAL_VARIABLES[database.type].map(({ field, value }) => [field, value])
  ) as ManagedDatabaseBindingEnvironment;
}

function hasCompleteEnvironment(
  database: ManagedDatabase | undefined,
  mode: ConnectionMode,
  environment: ManagedDatabaseBindingEnvironment
) {
  const values =
    mode === "uri"
      ? [environment.connectionUri]
      : database
        ? CREDENTIAL_VARIABLES[database.type].map(({ field }) => environment[field])
        : [];
  const trimmed = values.map((value) => value?.trim() ?? "");
  return (
    trimmed.length > 0 &&
    trimmed.every((value) => ENVIRONMENT_VARIABLE.test(value)) &&
    new Set(trimmed).size === trimmed.length
  );
}

function localDraftId() {
  return globalThis.crypto?.randomUUID?.() ?? `database-link-${Date.now()}-${Math.random()}`;
}

function composeServiceTarget(projectId: string, serviceName: string) {
  return `${projectId}:${encodeURIComponent(serviceName)}`;
}

function composeServiceName(projectId: string, targetResourceId: string) {
  const prefix = `${projectId}:`;
  if (!targetResourceId.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(targetResourceId.slice(prefix.length));
  } catch {
    return "";
  }
}

export const ManagedDatabaseLinksSection = forwardRef<
  ManagedDatabaseLinksSectionHandle,
  {
    nodeId: string;
    targetType: ManagedDatabaseBindingTargetType;
    targetResourceId: string;
    containerName: string;
    disabled?: boolean;
    existingVariableNames?: string[];
    onInitialLoadingChange?: (loading: boolean) => void;
    onDraftChange?: (draft: ManagedDatabaseLinkDraft) => void;
    onSaveRequested?: () => void;
    onMutationStart?: (transition: "updating" | "recreating") => void;
    onMutationEnd?: () => void;
    onRecreating?: () => void | Promise<void>;
    composeServices?: Array<{ name: string; existingVariableNames: string[] }>;
  }
>(function ManagedDatabaseLinksSection(
  {
    nodeId,
    targetType,
    targetResourceId,
    containerName,
    disabled = false,
    existingVariableNames = [],
    onInitialLoadingChange,
    onDraftChange,
    onSaveRequested,
    onMutationStart,
    onMutationEnd,
    onRecreating,
    composeServices = [],
  },
  ref
) {
  const navigate = useNavigate();
  const [databases, setDatabases] = useState<ManagedDatabase[]>([]);
  const [databaseNodes, setDatabaseNodes] = useState<Node[]>([]);
  const [bindings, setBindings] = useState<ManagedDatabaseBinding[]>([]);
  const [changes, setChanges] = useState<PendingDatabaseLinkChanges>(EMPTY_CHANGES);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState("");
  const [selectedComposeServiceName, setSelectedComposeServiceName] = useState(
    composeServices[0]?.name ?? ""
  );
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("uri");
  const [environment, setEnvironment] = useState<ManagedDatabaseBindingEnvironment>({
    connectionUri: "DATABASE_URL",
  });
  const [loading, setLoading] = useState(true);
  const initialLoading = useInitialLoading(loading);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [noAvailableDatabasesOpen, setNoAvailableDatabasesOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextDatabases, nodeResult] = await Promise.all([
        api.listManagedDatabases(),
        api.listNodes({ type: "databases", limit: 100 }),
      ]);
      const results = await Promise.all(
        nextDatabases.map(async (database) =>
          api.listManagedDatabaseBindings(database.id).catch(() => [] as ManagedDatabaseBinding[])
        )
      );
      setDatabases(nextDatabases);
      setDatabaseNodes(nodeResult.data);
      setBindings(
        results
          .flat()
          .filter(
            (binding) =>
              binding.targetNodeId === nodeId &&
              binding.targetType === targetType &&
              (targetType === "compose_service"
                ? composeServiceName(targetResourceId, binding.targetResourceId) !== ""
                : binding.targetResourceId === targetResourceId)
          )
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load database links");
    } finally {
      setLoading(false);
    }
  }, [nodeId, targetResourceId, targetType]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onInitialLoadingChange?.(initialLoading);
  }, [initialLoading, onInitialLoadingChange]);

  useRealtime("node.changed", () => {
    void api
      .listNodes({ type: "databases", limit: 100 })
      .then((result) => setDatabaseNodes(result.data))
      .catch(() => undefined);
  });

  const displayBindings = useMemo<DisplayBinding[]>(() => {
    const replacedBindingIds = new Set(
      changes.additions.flatMap((addition) =>
        addition.replacesBindingId ? [addition.replacesBindingId] : []
      )
    );
    return [
      ...bindings
        .filter((binding) => !replacedBindingIds.has(binding.id))
        .map((binding) => ({
          binding,
          pending: changes.removals.includes(binding.id) ? ("remove" as const) : null,
        })),
      ...changes.additions.map((addition) => ({
        binding: {
          id: addition.id,
          managedDatabaseId: addition.managedDatabaseId,
          targetNodeId: nodeId,
          targetType,
          targetResourceId: addition.targetResourceId,
          environment: addition.environment,
          status: "creating" as const,
          createdAt: "",
          updatedAt: "",
        },
        pending: "add" as const,
      })),
    ];
  }, [bindings, changes, nodeId, targetType]);
  const linkedTargets = useMemo(
    () =>
      new Set(
        displayBindings
          .filter((entry) => entry.pending !== "remove")
          .map(({ binding }) => `${binding.managedDatabaseId}:${binding.targetResourceId}`)
      ),
    [displayBindings]
  );
  const databaseNodeById = useMemo(
    () => new Map(databaseNodes.map((node) => [node.id, node])),
    [databaseNodes]
  );
  const databaseIsAvailable = useCallback(
    (database: ManagedDatabase) => {
      const node = databaseNodeById.get(database.nodeId);
      return database.status === "ready" && !!node && node.status === "online" && node.isConnected;
    },
    [databaseNodeById]
  );
  const selectedTargetResourceId =
    targetType === "compose_service"
      ? selectedComposeServiceName
        ? composeServiceTarget(targetResourceId, selectedComposeServiceName)
        : ""
      : targetResourceId;
  const available = useMemo(
    () =>
      databases.filter(
        (database) =>
          databaseIsAvailable(database) &&
          !!selectedTargetResourceId &&
          !linkedTargets.has(`${database.id}:${selectedTargetResourceId}`)
      ),
    [databaseIsAvailable, databases, linkedTargets, selectedTargetResourceId]
  );
  const selected = available.find((database) => database.id === selectedDatabaseId) ?? available[0];
  const hasChanges = changes.additions.length > 0 || changes.removals.length > 0;

  const managedVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          displayBindings
            .filter((entry) => entry.pending !== "remove")
            .flatMap((entry) => Object.values(entry.binding.environment).filter(Boolean))
        )
      ) as string[],
    [displayBindings]
  );
  const pendingAdditionVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          changes.additions.flatMap((addition) =>
            Object.values(addition.environment).filter(Boolean)
          )
        )
      ) as string[],
    [changes.additions]
  );
  const replacementVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          changes.additions
            .filter((addition) => addition.replacesExistingEnvironment)
            .flatMap((addition) => Object.values(addition.environment).filter(Boolean))
        )
      ) as string[],
    [changes.additions]
  );

  useEffect(() => {
    if (targetType !== "compose_service") return;
    if (!composeServices.some((service) => service.name === selectedComposeServiceName)) {
      setSelectedComposeServiceName(composeServices[0]?.name ?? "");
    }
  }, [composeServices, selectedComposeServiceName, targetType]);

  useEffect(() => {
    onDraftChange?.({
      hasChanges,
      managedVariableNames,
      pendingAdditionVariableNames,
      replacementVariableNames,
    });
  }, [
    hasChanges,
    managedVariableNames,
    onDraftChange,
    pendingAdditionVariableNames,
    replacementVariableNames,
  ]);

  useEffect(() => {
    if (!selected) {
      setSelectedDatabaseId("");
      return;
    }
    if (!available.some((database) => database.id === selectedDatabaseId)) {
      setSelectedDatabaseId(selected.id);
      setEnvironment(defaultEnvironment(selected, connectionMode));
    }
  }, [available, connectionMode, selected, selectedDatabaseId]);

  const databaseName = (binding: ManagedDatabaseBinding) =>
    databases.find((database) => database.id === binding.managedDatabaseId)?.name ??
    binding.managedDatabaseId;
  const databaseType = (binding: ManagedDatabaseBinding) =>
    databases.find((database) => database.id === binding.managedDatabaseId)?.type ?? "database";
  const databaseForBinding = (binding: ManagedDatabaseBinding) =>
    databases.find((database) => database.id === binding.managedDatabaseId);
  const environmentSummary = (binding: ManagedDatabaseBinding) =>
    Object.values(binding.environment).filter(Boolean).join(", ") || "credentials injected";

  const stageLink = async () => {
    if (
      !selected ||
      !selectedTargetResourceId ||
      !hasCompleteEnvironment(selected, connectionMode, environment)
    )
      return;
    const names = Object.values(environment)
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const targetManagedVariableNames = displayBindings
      .filter(
        (entry) =>
          entry.pending !== "remove" && entry.binding.targetResourceId === selectedTargetResourceId
      )
      .flatMap((entry) => Object.values(entry.binding.environment).filter(Boolean));
    if (names.some((name) => targetManagedVariableNames.includes(name))) {
      toast.error("A managed database link already uses one of these environment variables");
      return;
    }
    const existing = new Set(
      targetType === "compose_service"
        ? (composeServices.find((service) => service.name === selectedComposeServiceName)
            ?.existingVariableNames ?? [])
        : existingVariableNames
    );
    const collisions = names.filter((name) => existing.has(name));
    if (collisions.length > 0) {
      if (targetType === "compose_service") {
        toast.error(
          `${selectedComposeServiceName} already uses ${collisions.join(", ")}. Choose different variable names.`
        );
        return;
      }
      const ok = await confirm({
        title: "Replace existing variables?",
        description: `${collisions.join(", ")} already ${collisions.length === 1 ? "exists" : "exist"} on “${containerName}”. The managed database credentials will replace ${collisions.length === 1 ? "it" : "them"} when you save and recreate.`,
        confirmLabel: "Add link",
      });
      if (!ok) return;
    }
    setChanges((current) => ({
      ...current,
      additions: [
        ...current.additions,
        {
          id: localDraftId(),
          managedDatabaseId: selected.id,
          targetResourceId: selectedTargetResourceId,
          replacesExistingEnvironment: collisions.length > 0,
          environment: Object.fromEntries(
            Object.entries(environment)
              .map(([field, value]) => [field, value?.trim()])
              .filter(([, value]) => Boolean(value))
          ) as ManagedDatabaseBindingEnvironment,
        },
      ],
    }));
    setAddOpen(false);
  };

  const stageServiceChange = (entry: DisplayBinding, serviceName: string) => {
    if (targetType !== "compose_service") return;
    const nextTargetResourceId = composeServiceTarget(targetResourceId, serviceName);
    if (entry.binding.targetResourceId === nextTargetResourceId) return;

    const pendingAddition = changes.additions.find((addition) => addition.id === entry.binding.id);
    const replacedBinding = pendingAddition?.replacesBindingId
      ? bindings.find((binding) => binding.id === pendingAddition.replacesBindingId)
      : undefined;
    if (replacedBinding?.targetResourceId === nextTargetResourceId) {
      setChanges((current) => ({
        removals: current.removals.filter((id) => id !== replacedBinding.id),
        additions: current.additions.filter((addition) => addition.id !== entry.binding.id),
      }));
      return;
    }

    const environmentNames = Object.values(entry.binding.environment).filter(
      (value): value is string => Boolean(value)
    );
    const targetEnvironmentNames = new Set(
      composeServices.find((service) => service.name === serviceName)?.existingVariableNames ?? []
    );
    const conflicts = environmentNames.filter((name) => targetEnvironmentNames.has(name));
    if (conflicts.length > 0) {
      toast.error(
        `${serviceName} already uses ${conflicts.join(", ")}. Change the variable names before moving this link.`
      );
      return;
    }

    const duplicate = displayBindings.some(
      (candidate) =>
        candidate.binding.id !== entry.binding.id &&
        candidate.pending !== "remove" &&
        candidate.binding.managedDatabaseId === entry.binding.managedDatabaseId &&
        candidate.binding.targetResourceId === nextTargetResourceId
    );
    if (duplicate) {
      toast.error("This database is already linked to that Compose service");
      return;
    }

    if (entry.pending === "add") {
      setChanges((current) => ({
        ...current,
        additions: current.additions.map((addition) =>
          addition.id === entry.binding.id
            ? { ...addition, targetResourceId: nextTargetResourceId }
            : addition
        ),
      }));
      return;
    }

    setChanges((current) => ({
      removals: current.removals.includes(entry.binding.id)
        ? current.removals
        : [...current.removals, entry.binding.id],
      additions: [
        ...current.additions,
        {
          id: localDraftId(),
          managedDatabaseId: entry.binding.managedDatabaseId,
          targetResourceId: nextTargetResourceId,
          environment: entry.binding.environment,
          replacesExistingEnvironment: false,
          replacesBindingId: entry.binding.id,
        },
      ],
    }));
  };

  const stageUnlink = async (entry: DisplayBinding) => {
    if (entry.pending === "add") {
      setChanges((current) => ({
        removals: current.removals.filter(
          (id) =>
            id !==
            current.additions.find((addition) => addition.id === entry.binding.id)
              ?.replacesBindingId
        ),
        additions: current.additions.filter((addition) => addition.id !== entry.binding.id),
      }));
      return;
    }
    if (entry.pending === "remove") {
      setChanges((current) => ({
        ...current,
        removals: current.removals.filter((id) => id !== entry.binding.id),
      }));
      return;
    }

    const name = databaseName(entry.binding);
    const ok = await confirm({
      title: "Unlink Managed Database",
      description: `Unlink “${name}” from “${containerName}” when you save and recreate this container?`,
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    setChanges((current) => ({
      ...current,
      removals: [...current.removals, entry.binding.id],
    }));
  };

  const applyChanges = useCallback(
    async (options?: {
      replaceExistingEnvironment?: boolean;
      targetEnvironment?: Record<string, string>;
    }) => {
      if (!hasChanges) return;
      const remaining: PendingDatabaseLinkChanges = {
        additions: [...changes.additions],
        removals: [...changes.removals],
      };
      try {
        const createAddition = async (addition: PendingDatabaseLink) => {
          await api.createManagedDatabaseBinding(addition.managedDatabaseId, {
            targetNodeId: nodeId,
            targetType,
            targetResourceId: addition.targetResourceId,
            environment: addition.environment,
            ...(options?.replaceExistingEnvironment ? { replaceExistingEnvironment: true } : {}),
            ...(options?.targetEnvironment ? { targetEnvironment: options.targetEnvironment } : {}),
          });
          remaining.additions = remaining.additions.filter((item) => item.id !== addition.id);
        };

        // A Compose service move targets a different unique binding scope, so establish the
        // replacement first. If the later unlink fails, the database remains reachable and the
        // old link stays staged for removal instead of leaving the workload disconnected.
        for (const addition of changes.additions.filter((item) => item.replacesBindingId)) {
          await createAddition(addition);
        }
        for (const bindingId of changes.removals) {
          const binding = bindings.find((item) => item.id === bindingId);
          if (!binding) continue;
          if (options?.targetEnvironment) {
            await api.deleteManagedDatabaseBinding(binding.managedDatabaseId, binding.id, {
              targetEnvironment: options.targetEnvironment,
            });
          } else {
            await api.deleteManagedDatabaseBinding(binding.managedDatabaseId, binding.id);
          }
          remaining.removals = remaining.removals.filter((id) => id !== bindingId);
        }
        for (const addition of changes.additions.filter((item) => !item.replacesBindingId)) {
          await createAddition(addition);
        }
        setChanges(EMPTY_CHANGES);
        await load();
      } catch (error) {
        setChanges(remaining);
        await load();
        throw error;
      }
    },
    [bindings, changes, hasChanges, load, nodeId, targetType]
  );

  useImperativeHandle(ref, () => ({ applyChanges }), [applyChanges]);

  const save = async () => {
    if (!hasChanges) return;
    const ok = await confirm({
      title: "Save & Recreate",
      description:
        targetType === "compose_service"
          ? `Apply managed database link changes to “${containerName}”? A new immutable Compose revision will be applied and the service will be recreated.`
          : `Apply managed database link changes to “${containerName}”? The container will be recreated and experience downtime.`,
      confirmLabel: "Recreate",
      variant: "default",
    });
    if (!ok) return;

    setSaving(true);
    onMutationStart?.("recreating");
    try {
      await applyChanges();
      toast.success(
        targetType === "compose_service"
          ? "Managed database links updated — applying Compose revision"
          : "Managed database links updated — recreating container"
      );
      void Promise.resolve(onRecreating?.());
    } catch (error) {
      onMutationEnd?.();
      toast.error(error instanceof Error ? error.message : "Failed to save managed database links");
    } finally {
      setSaving(false);
    }
  };

  const credentialFields = selected ? CREDENTIAL_VARIABLES[selected.type] : [];
  const openAddDialog = () => {
    if (targetType === "compose_service") {
      const firstAvailableService = composeServices.find((service) => {
        const serviceTarget = composeServiceTarget(targetResourceId, service.name);
        return databases.some(
          (database) =>
            databaseIsAvailable(database) && !linkedTargets.has(`${database.id}:${serviceTarget}`)
        );
      });
      if (!firstAvailableService) {
        setNoAvailableDatabasesOpen(true);
        return;
      }
      setSelectedComposeServiceName(firstAvailableService.name);
      setAddOpen(true);
      return;
    }
    if (available.length === 0) {
      setNoAvailableDatabasesOpen(true);
      return;
    }
    setAddOpen(true);
  };

  return (
    <>
      <PanelShell
        title="Managed Database Links"
        icon={<Link2 className="h-4 w-4" />}
        description={
          targetType === "compose_service"
            ? "Private sidecar connections stored in each selected service's Compose revision."
            : "Private sidecar connections. Changes apply with Save & Recreate."
        }
        dirty={hasChanges}
        bodyClassName={displayBindings.length > 0 ? "divide-y divide-border" : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              className="bg-warning text-black hover:bg-warning/90 disabled:opacity-50"
              disabled={disabled || loading || saving || !hasChanges}
              onClick={() => (onSaveRequested ? onSaveRequested() : void save())}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Save & Recreate
            </Button>
            <Button type="button" disabled={disabled || loading || saving} onClick={openAddDialog}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        }
      >
        {initialLoading ? (
          <div
            className="divide-y divide-border"
            aria-busy="true"
            aria-label="Loading managed database links"
          >
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="flex min-h-16 items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-52" />
                </div>
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        ) : displayBindings.length === 0 ? (
          <EmptyState message="No managed database links" embedded />
        ) : (
          displayBindings.map((entry) => {
            const database = databaseForBinding(entry.binding);
            const databaseNode = database ? databaseNodeById.get(database.nodeId) : undefined;
            const unavailable = !!database && !!databaseNode && !databaseIsAvailable(database);
            return (
              <SettingsControlRow
                key={entry.binding.id}
                title={databaseName(entry.binding)}
                description={`${databaseType(entry.binding)} · ${environmentSummary(entry.binding)}`}
              >
                <div className="flex items-center gap-2">
                  {targetType === "compose_service" && (
                    <Select
                      value={composeServiceName(targetResourceId, entry.binding.targetResourceId)}
                      onValueChange={(serviceName) => stageServiceChange(entry, serviceName)}
                      disabled={disabled || saving || entry.pending === "remove"}
                    >
                      <SelectTrigger
                        className="w-44"
                        aria-label={`Compose service for ${databaseName(entry.binding)}`}
                      >
                        <SelectValue placeholder="Select service" />
                      </SelectTrigger>
                      <SelectContent>
                        {composeServices.map((service) => (
                          <SelectItem key={service.name} value={service.name}>
                            {service.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {databaseNode && (
                    <Badge
                      variant="secondary"
                      size="inline"
                      className={nodeBadgeClassName(databaseNode.appearanceColor)}
                    >
                      {databaseNode.displayName || databaseNode.hostname}
                    </Badge>
                  )}
                  {unavailable && <Badge variant="secondary">Unavailable</Badge>}
                  <Badge
                    variant={
                      entry.pending === "remove"
                        ? "warning"
                        : entry.pending === "add"
                          ? "secondary"
                          : entry.binding.status === "ready"
                            ? "success"
                            : "secondary"
                    }
                  >
                    {entry.pending === "remove"
                      ? "will unlink"
                      : entry.pending === "add"
                        ? "pending"
                        : entry.binding.status}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={disabled || saving}
                    onClick={() => void stageUnlink(entry)}
                    aria-label={
                      entry.pending === "remove"
                        ? `Keep ${databaseName(entry.binding)} linked`
                        : `Unlink ${databaseName(entry.binding)}`
                    }
                    title={entry.pending === "remove" ? "Keep link" : "Unlink database"}
                  >
                    {entry.pending === "remove" ? (
                      <Undo2 className="h-4 w-4" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </SettingsControlRow>
            );
          })
        )}
      </PanelShell>

      <Dialog open={noAvailableDatabasesOpen} onOpenChange={setNoAvailableDatabasesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>No managed databases available</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            There are no unlinked ready managed databases on an online databases node for this
            workload. Create a database, then return here to add a private connection.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setNoAvailableDatabasesOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setNoAvailableDatabasesOpen(false);
                navigate("/databases", { state: { createManagedDatabase: true } });
              }}
            >
              <Plus className="h-4 w-4" />
              Create database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Managed Database Link</DialogTitle>
            <DialogDescription>
              Gateway will inject the selected connection into this workload when you save and
              recreate it.
            </DialogDescription>
          </DialogHeader>

          <AnimatedHeight>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={connectionMode} {...FORM_ANIMATION}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {targetType === "compose_service" && (
                    <div className="space-y-1.5 sm:col-span-2">
                      <label className="text-sm font-medium" htmlFor="managed-db-link-service">
                        Compose service
                      </label>
                      <Select
                        value={selectedComposeServiceName}
                        onValueChange={setSelectedComposeServiceName}
                        disabled={disabled || saving}
                      >
                        <SelectTrigger id="managed-db-link-service">
                          <SelectValue placeholder="Select service" />
                        </SelectTrigger>
                        <SelectContent>
                          {composeServices.map((service) => (
                            <SelectItem key={service.name} value={service.name}>
                              {service.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="managed-db-link-database">
                      Database
                    </label>
                    <Select
                      value={selected?.id ?? ""}
                      onValueChange={(databaseId) => {
                        const database = available.find((item) => item.id === databaseId);
                        setSelectedDatabaseId(databaseId);
                        setEnvironment(defaultEnvironment(database, connectionMode));
                      }}
                      disabled={disabled || saving}
                    >
                      <SelectTrigger id="managed-db-link-database">
                        <SelectValue aria-label={selected?.name}>{selected?.name}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {available.map((database) => (
                          <SelectItem
                            key={database.id}
                            value={database.id}
                            description={
                              <span className="flex items-center gap-2">
                                <span>{database.type}</span>
                                {databaseNodeById.get(database.nodeId) && (
                                  <Badge
                                    variant="secondary"
                                    size="inline"
                                    className={nodeBadgeClassName(
                                      databaseNodeById.get(database.nodeId)?.appearanceColor
                                    )}
                                  >
                                    {databaseNodeById.get(database.nodeId)?.displayName ||
                                      databaseNodeById.get(database.nodeId)?.hostname}
                                  </Badge>
                                )}
                              </span>
                            }
                          >
                            {database.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="managed-db-link-mode">
                      Inject as
                    </label>
                    <Select
                      value={connectionMode}
                      onValueChange={(value) => {
                        const mode = value as ConnectionMode;
                        setConnectionMode(mode);
                        setEnvironment(defaultEnvironment(selected, mode));
                      }}
                      disabled={disabled || saving}
                    >
                      <SelectTrigger id="managed-db-link-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="uri">Connection URI</SelectItem>
                        <SelectItem value="credentials">Credential variables</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {connectionMode === "uri" ? (
                    <div className="space-y-1.5 sm:col-span-2">
                      <label className="text-sm font-medium" htmlFor="managed-db-link-uri">
                        Connection URI variable
                      </label>
                      <Input
                        id="managed-db-link-uri"
                        value={environment.connectionUri ?? ""}
                        onChange={(event) =>
                          setEnvironment((current) => ({
                            ...current,
                            connectionUri: event.target.value,
                          }))
                        }
                        placeholder="DATABASE_URL"
                        disabled={disabled || saving}
                      />
                    </div>
                  ) : (
                    credentialFields.map(({ field, label, value }) => (
                      <div key={field} className="space-y-1.5">
                        <label
                          className="text-sm font-medium"
                          htmlFor={`managed-db-link-variable-${field}`}
                        >
                          {label}
                        </label>
                        <Input
                          id={`managed-db-link-variable-${field}`}
                          value={environment[field] ?? ""}
                          onChange={(event) =>
                            setEnvironment((current) => ({
                              ...current,
                              [field]: event.target.value,
                            }))
                          }
                          placeholder={value}
                          disabled={disabled || saving}
                        />
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
          </AnimatedHeight>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                disabled ||
                saving ||
                !hasCompleteEnvironment(selected, connectionMode, environment) ||
                !selectedTargetResourceId
              }
              onClick={() => void stageLink()}
            >
              <Link2 className="h-4 w-4" />
              Add link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
