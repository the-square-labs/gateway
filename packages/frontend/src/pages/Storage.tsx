import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  FolderPlus,
  HardDrive,
  HardDriveDownload,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { ManagedResourceFields } from "@/components/common/ManagedResourceFields";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { ToggleField } from "@/components/common/ToggleField";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { storageRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type {
  ManagedObjectStorage,
  ManagedObjectStorageCatalogEntry,
  ManagedObjectStorageCreateInput,
  ManagedObjectStorageStatus,
  Node,
  ObjectStorageConnection,
  ObjectStorageProvider,
} from "@/types";
import {
  canDeployManagedStorage,
  type ManagedStorageCapacity,
  managedStorageCapacity,
} from "./storage-detail/managed-storage-capacity";
import {
  buildStoragePayload,
  draftFromConnection,
  type StorageConnectionDraft,
  StorageConnectionForm,
} from "./storage-detail/StorageConnectionForm";
import { formatProviderLabel } from "./storage-detail/shared";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

const MANAGED_STORAGE_STATUS_BADGE: Record<
  string,
  "success" | "secondary" | "warning" | "destructive"
> = {
  creating: "secondary",
  updating: "warning",
  ready: "success",
  stopped: "secondary",
  error: "destructive",
  deleting: "warning",
};

const MANAGED_STORAGE_PROVISION_TIMEOUT_MS = 120_000;
const MANAGED_STORAGE_PROVISION_INTERVAL_MS = 750;

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForManagedObjectStorageReady(id: string): Promise<ManagedObjectStorage> {
  const deadline = Date.now() + MANAGED_STORAGE_PROVISION_TIMEOUT_MS;
  let current = await api.getManagedObjectStorage(id);
  while (current.status !== "ready" && current.status !== "error" && Date.now() < deadline) {
    await delay(MANAGED_STORAGE_PROVISION_INTERVAL_MS);
    current = await api.getManagedObjectStorage(id);
  }
  if (current.status === "ready" || current.status === "error") return current;
  throw new Error("Managed storage is still starting. Check its status from the storage list.");
}

const DEFAULT_MANAGED_STORAGE_VERSIONS = ["RELEASE.2025-04-08T15-41-24Z"];

const MANAGED_STORAGE_FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

function catalogStorageVersions(catalog: ManagedObjectStorageCatalogEntry[]): string[] {
  return (
    catalog.find((entry) => entry.type === "minio")?.versions ?? DEFAULT_MANAGED_STORAGE_VERSIONS
  );
}

function defaultManagedStorageDraft(
  catalog: ManagedObjectStorageCatalogEntry[] = []
): ManagedObjectStorageCreateInput {
  return {
    name: "",
    version: catalogStorageVersions(catalog)[0]!,
    nodeId: "",
    storageSizeGb: 10,
    cpuCores: 1,
    memoryMb: 1024,
    swapMb: 0,
    publishedPort: 9000,
    publishS3: false,
    relayEnabled: true,
    tlsEnabled: true,
    sftpEnabled: false,
    sftpPort: 8022,
    ftpEnabled: false,
    ftpPort: 2121,
    ftpPassivePortStart: 30000,
    ftpPassivePortCount: 10,
    tags: [],
  };
}

function parseStorageTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

const STORAGE_TAG_COLORS = {
  blue: "bg-blue-500/15 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
  red: "bg-red-500/15 text-red-600 dark:bg-red-500/15 dark:text-red-400",
  green: "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  yellow: "bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  purple: "bg-violet-500/15 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  pink: "bg-pink-500/15 text-pink-600 dark:bg-pink-500/15 dark:text-pink-400",
  orange: "bg-orange-500/15 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
  gray: "bg-zinc-500/15 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-300",
} as const;

type StorageTagColor = keyof typeof STORAGE_TAG_COLORS;

interface ParsedStorageTag {
  raw: string;
  label: string;
  color: StorageTagColor;
}

function parseStorageTag(raw: string): ParsedStorageTag {
  const trimmed = raw.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const color = trimmed.slice(0, colonIndex).toLowerCase();
    const label = trimmed.slice(colonIndex + 1).trim();
    if (color in STORAGE_TAG_COLORS && label) {
      return { raw, label, color: color as StorageTagColor };
    }
  }
  return { raw, label: trimmed, color: "blue" };
}

function estimateTagWidth(tag: ParsedStorageTag): number {
  return Math.min(180, Math.max(44, tag.label.length * 7 + 24));
}

function estimateMoreWidth(count: number): number {
  return 44 + String(count).length * 7;
}

function formatLastCheck(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString();
}

function formatHealthLabel(
  status: ObjectStorageConnection["healthStatus"] | ManagedObjectStorageStatus
): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function StorageTagSummary({
  tags,
  provider,
}: {
  tags: string[];
  provider: ObjectStorageConnection["provider"];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const typeRef = useRef<HTMLSpanElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [typeWidth, setTypeWidth] = useState<number | null>(null);
  const parsedTags = useMemo(() => tags.map(parseStorageTag), [tags]);
  const visibleCount = useMemo(() => {
    if (parsedTags.length <= 2 && containerWidth === null) return parsedTags.length;
    if (containerWidth === null || containerWidth <= 0) return Math.min(2, parsedTags.length);

    const gapWidth = 8;
    const availableWidth = Math.max(0, containerWidth - (typeWidth ?? 0) - gapWidth);
    let usedWidth = 0;
    let count = 0;

    for (let index = 0; index < parsedTags.length; index += 1) {
      const remaining = parsedTags.length - index - 1;
      const tagWidth = estimateTagWidth(parsedTags[index]!);
      const moreWidth = remaining > 0 ? estimateMoreWidth(remaining) + gapWidth : 0;
      const nextWidth = usedWidth + (count > 0 ? gapWidth : 0) + tagWidth;
      if (nextWidth + moreWidth > availableWidth) break;
      usedWidth = nextWidth;
      count += 1;
    }

    return Math.max(1, count);
  }, [containerWidth, parsedTags, typeWidth]);

  useEffect(() => {
    const container = containerRef.current;
    const typeBadge = typeRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(container.getBoundingClientRect().width);
      if (typeBadge) setTypeWidth(typeBadge.getBoundingClientRect().width);
    });
    observer.observe(container);
    if (typeBadge) observer.observe(typeBadge);
    return () => observer.disconnect();
  }, []);

  const visibleTags = parsedTags.slice(0, visibleCount);
  const hiddenTags = parsedTags.slice(visibleCount);

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <span ref={typeRef} className="inline-flex shrink-0">
        <Badge variant="secondary">{formatProviderLabel(provider)}</Badge>
      </span>
      {visibleTags.map((tag, index) => (
        <Badge
          key={`${tag.raw}:${index}`}
          variant="secondary"
          className={cn("max-w-[180px]", STORAGE_TAG_COLORS[tag.color])}
          title={tag.raw}
        >
          {tag.label}
        </Badge>
      ))}
      {hiddenTags.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="shrink-0">
              +{hiddenTags.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="flex flex-wrap gap-1.5">
              {hiddenTags.map((tag, index) => (
                <Badge
                  key={`${tag.raw}:${visibleCount + index}`}
                  variant="secondary"
                  className={cn("max-w-[180px]", STORAGE_TAG_COLORS[tag.color])}
                >
                  {tag.label}
                </Badge>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ManagedObjectStorageCreateForm({
  draft,
  nodes,
  catalog,
  capacity,
  step,
  onChange,
}: {
  draft: ManagedObjectStorageCreateInput;
  nodes: Node[];
  catalog: ManagedObjectStorageCatalogEntry[];
  capacity: ManagedStorageCapacity;
  step: 1 | 2 | 3;
  onChange: (draft: ManagedObjectStorageCreateInput) => void;
}) {
  const set = <K extends keyof ManagedObjectStorageCreateInput>(
    key: K,
    value: ManagedObjectStorageCreateInput[K]
  ) => onChange({ ...draft, [key]: value });
  const [resourceInputs, setResourceInputs] = useState(() => ({
    storageSizeGb: String(draft.storageSizeGb),
    cpuCores: String(draft.cpuCores),
    memoryMb: String(draft.memoryMb),
    swapMb: String(draft.swapMb),
    publishedPort: String(draft.publishedPort),
    sftpPort: String(draft.sftpPort ?? 8022),
    ftpPort: String(draft.ftpPort ?? 2121),
    ftpPassivePortStart: String(draft.ftpPassivePortStart ?? 30000),
    ftpPassivePortCount: String(draft.ftpPassivePortCount ?? 10),
  }));
  const setResourceInput = (
    key:
      | "storageSizeGb"
      | "cpuCores"
      | "memoryMb"
      | "swapMb"
      | "publishedPort"
      | "sftpPort"
      | "ftpPort"
      | "ftpPassivePortStart"
      | "ftpPassivePortCount",
    value: string
  ) => {
    setResourceInputs((current) => ({ ...current, [key]: value }));
    set(key, value === "" ? 0 : Number(value));
  };
  const [tagsInput, setTagsInput] = useState(() => (draft.tags ?? []).join(", "));
  const versions = catalogStorageVersions(catalog);

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {step === 1 && (
        <motion.div
          key="managed-storage-step-1"
          {...MANAGED_STORAGE_FORM_ANIMATION}
          className="space-y-4"
        >
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-storage-name">
                Name
              </label>
              <Input
                id="managed-storage-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Production storage"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-storage-node">
                Storage node
              </label>
              <Select value={draft.nodeId} onValueChange={(value) => set("nodeId", value)}>
                <SelectTrigger id="managed-storage-node">
                  <SelectValue placeholder="Select node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.displayName || node.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {nodes.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No Storage nodes available — enroll a Storage node first, then it appears here.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Curated version</label>
              <Select value={draft.version} onValueChange={(value) => set("version", value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((version) => (
                    <SelectItem key={version} value={version}>
                      {version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <ToggleField
            title="Distributed cluster"
            description="Use at least four Storage nodes, one disk per node. Resources below apply to every member."
            checked={Boolean(draft.memberNodeIds)}
            onChange={(enabled) =>
              set("memberNodeIds", enabled ? [draft.nodeId].filter(Boolean) : undefined)
            }
            ariaLabel="Distributed cluster"
          />
          {draft.memberNodeIds && (
            <div className="space-y-2">
              {nodes.map((node) => (
                <ToggleField
                  key={node.id}
                  title={node.displayName || node.hostname}
                  description={
                    node.serviceAddress || "Configure a service IP before adding this member"
                  }
                  checked={draft.memberNodeIds!.includes(node.id)}
                  onChange={(enabled) => {
                    const selected = enabled
                      ? [...draft.memberNodeIds!, node.id]
                      : draft.memberNodeIds!.filter((id) => id !== node.id);
                    onChange({
                      ...draft,
                      memberNodeIds: selected,
                      nodeId: selected[0] ?? draft.nodeId,
                    });
                  }}
                  ariaLabel={node.displayName || node.hostname}
                />
              ))}
              {draft.memberNodeIds.length < 4 && (
                <p className="text-xs text-muted-foreground">
                  Select at least four distinct nodes.
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-tags">
              Tags
            </label>
            <Input
              id="managed-storage-tags"
              value={tagsInput}
              onChange={(event) => {
                setTagsInput(event.target.value);
                set("tags", parseStorageTags(event.target.value));
              }}
              placeholder="team, green:production, analytics"
            />
            <p className="text-xs text-muted-foreground">
              Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple,
              pink, orange, gray.
            </p>
          </div>
        </motion.div>
      )}

      {step === 2 && (
        <motion.div
          key="managed-storage-step-2"
          {...MANAGED_STORAGE_FORM_ANIMATION}
          className="space-y-4"
        >
          <ManagedResourceFields
            idPrefix="managed-storage"
            values={resourceInputs}
            capacity={{
              storageSizeGb: capacity.maxStorageGb || undefined,
              cpuCores: capacity.maxCpuCores || undefined,
              memoryMb: capacity.maxMemoryMb || undefined,
              swapMb: capacity.maxSwapMb || undefined,
            }}
            onChange={setResourceInput}
            minimumStorageGb={1}
            minimumMemoryMb={256}
          />
        </motion.div>
      )}
      {step === 3 && (
        <motion.div
          key="managed-storage-step-3"
          {...MANAGED_STORAGE_FORM_ANIMATION}
          className="space-y-4"
        >
          <ToggleField
            title="Publish S3 endpoint"
            description="Expose a host port in addition to private access."
            checked={draft.publishS3 ?? false}
            onChange={(enabled) => set("publishS3", enabled)}
            ariaLabel="Publish S3 endpoint"
          />
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-publishedPort">
              S3 API port
            </label>
            <Input
              id="managed-storage-publishedPort"
              aria-label="S3 API port"
              type="number"
              min="1"
              max={65535}
              disabled={!draft.publishS3}
              value={resourceInputs.publishedPort}
              onChange={(event) => setResourceInput("publishedPort", event.target.value)}
            />
          </div>
          <ToggleField
            title="TLS"
            description="Encrypt S3 and enable FTPS using the Gateway Storage CA."
            checked={draft.tlsEnabled ?? false}
            onChange={(enabled) => set("tlsEnabled", enabled)}
            ariaLabel="TLS"
          />
          <ToggleField
            title="SFTP access"
            checked={draft.sftpEnabled ?? false}
            onChange={(enabled) => set("sftpEnabled", enabled)}
            ariaLabel="SFTP access"
          />
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-sftpPort">
              SFTP port
            </label>
            <Input
              id="managed-storage-sftpPort"
              aria-label="SFTP port"
              type="number"
              min="1"
              max={65535}
              disabled={!draft.sftpEnabled}
              value={resourceInputs.sftpPort}
              onChange={(event) => setResourceInput("sftpPort", event.target.value)}
            />
          </div>
          <ToggleField
            title="FTP access"
            checked={draft.ftpEnabled ?? false}
            onChange={(enabled) => set("ftpEnabled", enabled)}
            ariaLabel="FTP access"
          />
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-ftpPort">
              FTP port
            </label>
            <Input
              id="managed-storage-ftpPort"
              aria-label="FTP port"
              type="number"
              min="1"
              max={65535}
              disabled={!draft.ftpEnabled}
              value={resourceInputs.ftpPort}
              onChange={(event) => setResourceInput("ftpPort", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-ftpPassivePortStart">
              FTP passive port range start
            </label>
            <Input
              id="managed-storage-ftpPassivePortStart"
              aria-label="FTP passive port range start"
              type="number"
              min="1"
              max={65526}
              disabled={!draft.ftpEnabled}
              value={resourceInputs.ftpPassivePortStart}
              onChange={(event) => setResourceInput("ftpPassivePortStart", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-ftpPassivePortCount">
              FTP passive port count
            </label>
            <Input
              id="managed-storage-ftpPassivePortCount"
              aria-label="FTP passive port count"
              type="number"
              min="1"
              max={64}
              disabled={!draft.ftpEnabled}
              value={resourceInputs.ftpPassivePortCount}
              onChange={(event) => setResourceInput("ftpPassivePortCount", event.target.value)}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Storage() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess, isLoading: authLoading } = useAuthStore();
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<"all" | ObjectStorageProvider>("all");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "online" | "offline" | "degraded" | "unknown"
  >("all");
  const storageCacheKey = useMemo(
    () => `storage:list:${search}:${providerFilter}:${healthFilter}`,
    [healthFilter, providerFilter, search]
  );
  const [rows, setRows] = useState<ObjectStorageConnection[]>(
    () =>
      api.getCached<ObjectStorageConnection[]>("storage:list::all:all") ??
      api.getCached<ObjectStorageConnection[]>("storage:list") ??
      []
  );
  const [loading, setLoading] = useState(
    () =>
      api.getCached<ObjectStorageConnection[]>("storage:list::all:all") === undefined &&
      api.getCached<ObjectStorageConnection[]>("storage:list") === undefined
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<StorageConnectionDraft>(draftFromConnection(null));
  const [saving, setSaving] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [managedCreateOpen, setManagedCreateOpen] = useState(false);
  const [managedCreateStep, setManagedCreateStep] = useState<1 | 2 | 3>(1);
  const [managedCreateSession, setManagedCreateSession] = useState(0);
  const [managedDraft, setManagedDraft] = useState<ManagedObjectStorageCreateInput>(
    defaultManagedStorageDraft
  );
  const [managedCatalog, setManagedCatalog] = useState<ManagedObjectStorageCatalogEntry[]>([]);
  const [storageNodes, setStorageNodes] = useState<Node[]>([]);
  const [managedSaving, setManagedSaving] = useState(false);
  const [managedProvisioning, setManagedProvisioning] = useState<{ phase: "waiting" } | null>(null);
  const [managedProvisioningError, setManagedProvisioningError] = useState<{
    managedStorageId: string;
    error: string;
  } | null>(null);
  const [managedRetrying, setManagedRetrying] = useState(false);
  const retainedProvisioningError = useRetainedDialogValue(
    managedProvisioningError,
    managedProvisioningError !== null
  );

  const openManagedCreate = useCallback(() => {
    if (!requireLicenseFeature("managed-storage", "Managed storage")) return;
    setManagedDraft(defaultManagedStorageDraft(managedCatalog));
    setManagedCreateStep(1);
    setManagedCreateSession((session) => session + 1);
    setManagedProvisioning(null);
    setManagedCreateOpen(true);
  }, [managedCatalog]);

  const closeManagedCreate = useCallback(() => {
    if (managedProvisioning?.phase === "waiting") return;
    setManagedCreateOpen(false);
    setManagedProvisioning(null);
  }, [managedProvisioning]);

  const showManagedProvisioningError = useCallback(
    (failure: { managedStorageId: string; error: string }) => {
      setManagedCreateOpen(false);
      setManagedProvisioning(null);
      window.setTimeout(() => setManagedProvisioningError(failure), 250);
    },
    []
  );

  const load = useCallback(async () => {
    const cachedRows = api.getCached<ObjectStorageConnection[]>(storageCacheKey);
    if (cachedRows) {
      setRows(cachedRows);
      setLoading(false);
    } else {
      setRows([]);
      setLoading(true);
    }
    try {
      const result = await api.listObjectStorages({
        limit: 200,
        search: search || undefined,
        provider: providerFilter === "all" ? undefined : providerFilter,
        healthStatus: healthFilter === "all" ? undefined : healthFilter,
      });
      api.setCache(storageCacheKey, result.data);
      if (search === "" && providerFilter === "all" && healthFilter === "all") {
        api.setCache("storage:list", result.data);
      }
      setRows(result.data);
      const [nodes, catalog] = await Promise.allSettled([
        api.listNodes({ type: "storage", limit: 100 }),
        api.listManagedObjectStorageCatalog(),
      ]);
      if (nodes.status === "fulfilled") setStorageNodes(nodes.value.data);
      if (catalog.status === "fulfilled") setManagedCatalog(catalog.value);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load storage");
    } finally {
      setLoading(false);
    }
  }, [healthFilter, providerFilter, search, storageCacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate = hasScopedAccess("storage:create");
  const canManageFolders = hasScope("storage:folders:manage");

  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          hasScopedAccess("storage:view") &&
          (hasScope("storage:view") || hasScope(`storage:view:${row.id}`))
      ),
    [hasScope, hasScopedAccess, rows]
  );

  const managedVersions = useMemo(() => catalogStorageVersions(managedCatalog), [managedCatalog]);
  const storageNodeById = useMemo(
    () => new Map(storageNodes.map((node) => [node.id, node])),
    [storageNodes]
  );
  const deployableStorageNodes = useMemo(
    () => storageNodes.filter((node) => node.status === "online" && node.isConnected),
    [storageNodes]
  );
  const selectedDeployableStorageNode = useMemo(
    () => deployableStorageNodes.find((node) => node.id === managedDraft.nodeId),
    [deployableStorageNodes, managedDraft.nodeId]
  );
  const managedCapacity = useMemo(
    () => managedStorageCapacity(selectedDeployableStorageNode),
    [selectedDeployableStorageNode]
  );
  const canDeployManaged = useMemo(
    () =>
      !!selectedDeployableStorageNode &&
      canDeployManagedStorage(managedDraft, managedVersions, managedCapacity),
    [managedCapacity, managedDraft, managedVersions, selectedDeployableStorageNode]
  );
  const managedCreateStepLabel = { 1: "Storage", 2: "Resources", 3: "Network access" }[
    managedCreateStep
  ];
  const canContinueManagedCreate =
    managedCreateStep === 1
      ? managedDraft.name.trim().length > 0 &&
        deployableStorageNodes.some((node) => node.id === managedDraft.nodeId) &&
        managedVersions.includes(managedDraft.version)
      : canDeployManagedStorage(
          { ...managedDraft, publishedPort: 9000, sftpEnabled: false, ftpEnabled: false },
          managedVersions,
          managedCapacity
        );

  const save = async () => {
    setSaving(true);
    try {
      const created = await api.createObjectStorage(buildStoragePayload(draft));
      toast.success("Storage connection created");
      setCreateOpen(false);
      setDraft(draftFromConnection(null));
      navigate(storageRoute(created.slug, "overview"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create storage connection");
    } finally {
      setSaving(false);
    }
  };

  const saveManaged = async () => {
    if (!canDeployManaged) {
      toast.error("Complete the managed storage settings with valid resource limits");
      return;
    }
    setManagedSaving(true);
    setManagedProvisioning({ phase: "waiting" });
    let created: ManagedObjectStorage | null = null;
    try {
      created = await api.createManagedObjectStorage(managedDraft);
      const provisioned = await waitForManagedObjectStorageReady(created.id);
      if (provisioned.status !== "ready" || !provisioned.objectStorageConnectionId) {
        showManagedProvisioningError({
          managedStorageId: provisioned.id,
          error: provisioned.lastError ?? "Managed storage provisioning failed",
        });
        return;
      }
      toast.success("Managed storage is ready");
      setManagedCreateOpen(false);
      setManagedProvisioning(null);
      const connection = await api.getObjectStorage(provisioned.objectStorageConnectionId);
      navigate(storageRoute(connection.slug, "browser"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create managed storage";
      if (created) {
        showManagedProvisioningError({ managedStorageId: created.id, error: message });
      } else {
        setManagedProvisioning(null);
        if (!handleLicenseApiError(error, "Managed storage")) toast.error(message);
      }
    } finally {
      setManagedSaving(false);
    }
  };

  const retryManagedProvisioning = async () => {
    if (!managedProvisioningError) return;
    setManagedRetrying(true);
    try {
      const retried = await api.retryManagedObjectStorageProvisioning(
        managedProvisioningError.managedStorageId
      );
      const provisioned = await waitForManagedObjectStorageReady(retried.id);
      if (provisioned.status !== "ready" || !provisioned.objectStorageConnectionId) {
        setManagedProvisioningError({
          managedStorageId: provisioned.id,
          error: provisioned.lastError ?? "Managed storage provisioning failed",
        });
        return;
      }
      toast.success("Managed storage is ready");
      setManagedProvisioningError(null);
      const connection = await api.getObjectStorage(provisioned.objectStorageConnectionId);
      navigate(storageRoute(connection.slug, "browser"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry provisioning");
    } finally {
      setManagedRetrying(false);
    }
  };

  const columns = useMemo<ResourceListColumn<ObjectStorageConnection>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: "38%",
        renderCell: (row) => {
          const Icon = row.managed ? HardDriveDownload : HardDrive;
          const node = row.managed ? storageNodeById.get(row.managed.nodeId) : undefined;
          const iconClassNames = nodeIconClassNames(node?.appearanceColor);

          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Icon className={cn("h-5 w-5", iconClassNames.icon)} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.endpoint || formatProviderLabel(row.provider)}
                  {row.defaultBucket ? ` · ${row.defaultBucket}` : ""}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "tags",
        label: "Tags",
        width: "34%",
        align: "right",
        renderCell: (row) => <StorageTagSummary tags={row.tags} provider={row.provider} />,
      },
      {
        id: "lastCheck",
        label: "Last Check",
        width: "14%",
        align: "center",
        renderCell: (row) => (
          <Badge variant="outline">{formatLastCheck(row.lastHealthCheckAt)}</Badge>
        ),
      },
      {
        id: "health",
        label: "Health",
        width: "14%",
        align: "center",
        renderCell: (row) => {
          if (row.managed) {
            return (
              <Badge variant={MANAGED_STORAGE_STATUS_BADGE[row.managed.status] ?? "secondary"}>
                {formatHealthLabel(row.managed.status)}
              </Badge>
            );
          }
          return (
            <Badge variant={HEALTH_BADGE[row.healthStatus] ?? "secondary"}>
              {formatHealthLabel(row.healthStatus)}
            </Badge>
          );
        },
      },
    ],
    [storageNodeById]
  );

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Storage</h1>
              <p className="text-sm text-muted-foreground">
                Saved S3-compatible object storage connections managed through Gateway
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              {
                label: "Refresh",
                icon: <RefreshCw className="h-4 w-4" />,
                onClick: () => void load(),
              },
              ...(canManageFolders && createFolderAction
                ? [
                    {
                      label: "Add Folder",
                      icon: <FolderPlus className="h-4 w-4" />,
                      onClick: createFolderAction,
                    },
                  ]
                : []),
              ...(canCreate
                ? [
                    {
                      label: "Deploy managed storage",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: openManagedCreate,
                    },
                    {
                      label: "Connect existing storage",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => setCreateOpen(true),
                    },
                  ]
                : []),
            ]}
          >
            <Button variant="outline" size="icon" onClick={() => void load()} title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {canManageFolders && (
              <Button variant="outline" onClick={() => createFolderAction?.()}>
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Button>
            )}
            {canCreate && (
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Connect existing
              </Button>
            )}
            {canCreate && (
              <Button onClick={openManagedCreate}>
                <Plus className="h-4 w-4" />
                Deploy managed storage
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        <FolderedResourceList<ObjectStorageConnection>
          resourceType="storage"
          realtimeChannel="storage.folder.changed"
          resources={filtered}
          columns={columns}
          search={{
            placeholder: "Search storage...",
            search,
            onSearchChange: setSearch,
            onSearchSubmit: () => void load(),
            hasActiveFilters: search !== "" || providerFilter !== "all" || healthFilter !== "all",
            onReset: () => {
              setSearch("");
              setProviderFilter("all");
              setHealthFilter("all");
            },
            filters: (
              <>
                <Select
                  value={providerFilter}
                  onValueChange={(value) => setProviderFilter(value as typeof providerFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All providers</SelectItem>
                    <SelectItem value="aws">AWS S3</SelectItem>
                    <SelectItem value="cloudflare_r2">Cloudflare R2</SelectItem>
                    <SelectItem value="minio">MinIO</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                    <SelectItem value="sftp">SFTP</SelectItem>
                    <SelectItem value="ftp">FTP</SelectItem>
                    <SelectItem value="ftps">FTPS</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={healthFilter}
                  onValueChange={(value) => setHealthFilter(value as typeof healthFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Health" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All health states</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="degraded">Degraded</SelectItem>
                    <SelectItem value="offline">Offline</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ),
          }}
          loading={loading || authLoading}
          loadingLabel="Loading storage connections..."
          emptyState={
            <EmptyState
              message="No storage connections. Add an S3-compatible bucket to manage it through Gateway."
              {...(canCreate
                ? { actionLabel: "Add Storage", onAction: () => setCreateOpen(true) }
                : {})}
              hasActiveFilters={search !== "" || providerFilter !== "all" || healthFilter !== "all"}
              onReset={() => {
                setSearch("");
                setProviderFilter("all");
                setHealthFilter("all");
              }}
            />
          }
          minWidth={920}
          canManageFolders={canManageFolders}
          canViewItem={(row) => hasScope("storage:view") || hasScope(`storage:view:${row.id}`)}
          canReorganizeItem={() => canManageFolders}
          getResourceLabel={(row) => row.name}
          onItemClick={(row) => navigate(storageRoute(row.slug, "overview"))}
          onRefresh={() => load()}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Storage</DialogTitle>
            <DialogDescription>
              Connect an existing S3-compatible, FTP, FTPS, or SFTP endpoint.
            </DialogDescription>
          </DialogHeader>
          <StorageConnectionForm draft={draft} onChange={setDraft} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={managedCreateOpen}
        onOpenChange={(open) => {
          if (open) openManagedCreate();
          else closeManagedCreate();
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          onEscapeKeyDown={(event) => {
            if (managedProvisioning?.phase === "waiting") event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (managedProvisioning?.phase === "waiting") event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Deploy managed storage</DialogTitle>
            <DialogDescription>
              Step {managedCreateStep} of 3 — {managedCreateStepLabel}
            </DialogDescription>
          </DialogHeader>
          <AnimatedHeight>
            <ManagedObjectStorageCreateForm
              key={managedCreateSession}
              draft={managedDraft}
              nodes={deployableStorageNodes}
              catalog={managedCatalog}
              capacity={managedCapacity}
              step={managedCreateStep}
              onChange={setManagedDraft}
            />
          </AnimatedHeight>
          <DialogFooter>
            {managedCreateStep === 1 ? (
              <>
                <Button variant="outline" onClick={closeManagedCreate} disabled={managedSaving}>
                  Cancel
                </Button>
                <Button
                  onClick={() => setManagedCreateStep(2)}
                  disabled={managedSaving || !canContinueManagedCreate}
                >
                  Next <ArrowRight className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <div className="flex w-full justify-between">
                <Button
                  variant="outline"
                  onClick={() => setManagedCreateStep((step) => (step - 1) as 1 | 2 | 3)}
                  disabled={managedSaving}
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                {managedCreateStep === 2 ? (
                  <Button
                    onClick={() => setManagedCreateStep(3)}
                    disabled={managedSaving || !canContinueManagedCreate}
                  >
                    Next <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    onClick={() => void saveManaged()}
                    disabled={managedSaving || !canDeployManaged}
                  >
                    {managedSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                    {managedSaving ? "Deploying..." : "Deploy storage"}
                  </Button>
                )}
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={managedProvisioningError !== null}
        onOpenChange={(open) => !open && setManagedProvisioningError(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Storage provisioning failed</DialogTitle>
            <DialogDescription>
              What the node reported, and the options for recovering this cluster.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{retainedProvisioningError?.error}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setManagedProvisioningError(null)}
              disabled={managedRetrying}
            >
              Close
            </Button>
            <Button onClick={() => void retryManagedProvisioning()} disabled={managedRetrying}>
              {managedRetrying && <Loader2 className="h-4 w-4 animate-spin" />}
              {managedRetrying ? "Retrying..." : "Retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
