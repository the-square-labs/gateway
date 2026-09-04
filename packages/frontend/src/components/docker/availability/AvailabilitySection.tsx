import { RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type {
  DockerAvailabilityIssue,
  DockerAvailabilityMode,
  DockerAvailabilityPlacement,
  DockerAvailabilityPolicy,
  DockerAvailabilityPolicyInput,
  DockerAvailabilityResource,
  Node,
} from "@/types";
import { resolveAvailabilitySurfaceStatus } from "./availability-status";
import { useStableAvailabilityResource } from "./use-stable-availability-resource";

function statusVariant(status: string) {
  if (["online", "healthy", "serving", "ready", "completed"].includes(status))
    return "success" as const;
  if (["offline", "failed", "unavailable", "unhealthy"].includes(status))
    return "destructive" as const;
  if (
    [
      "degraded",
      "enabling",
      "scaling",
      "rolling_out",
      "starting",
      "stopping",
      "restarting",
      "disabling",
      "waiting",
      "draining",
      "unreachable",
      "stale",
      "cleanup_pending",
    ].includes(status)
  ) {
    return "warning" as const;
  }
  return "secondary" as const;
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function time(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function nodeName(nodeId: string, nodes: Node[]) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.displayName || node?.hostname || node?.slug || nodeId.slice(0, 12);
}

export function canKeepPlacement(
  placement: DockerAvailabilityPlacement,
  shouldRun: boolean
): boolean {
  if (["removed", "stale", "cleanup_pending", "unreachable"].includes(placement.actualState))
    return false;
  if (!shouldRun) return placement.actualState === "stopped" || placement.actualState === "serving";
  return (
    placement.serving &&
    placement.actualState === "serving" &&
    placement.dependencyState === "ready" &&
    placement.applicationHealth === "healthy"
  );
}

function StatusBadge({ status, error }: { status: string; error?: string | null }) {
  const badge = (
    <Badge
      size="inline"
      variant={statusVariant(status)}
      tabIndex={error ? 0 : undefined}
      aria-label={error ? `${label(status)}: ${error}` : undefined}
    >
      {label(status)}
    </Badge>
  );
  if (!error) return badge;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm break-words">
          {error}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PlacementRows({
  placements,
  nodes,
  shouldRun,
}: {
  placements: DockerAvailabilityPlacement[];
  nodes: Node[];
  shouldRun: boolean;
}) {
  const visible = placements.filter((placement) => placement.actualState !== "removed");
  if (visible.length === 0) {
    return (
      <EmptyState
        embedded
        message="No placements yet. Placements appear after Availability starts."
      />
    );
  }
  return (
    <div className="divide-y divide-border">
      {visible.map((placement) => (
        <div
          key={placement.id}
          className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">
                {nodeName(placement.nodeId, nodes)}
              </span>
              <StatusBadge status={placement.actualState} error={placement.lastErrorMessage} />
              {placement.serving && placement.actualState !== "serving" && (
                <Badge size="inline" variant="success">
                  Serving
                </Badge>
              )}
            </div>
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={placement.imageReference ?? undefined}
            >
              Generation {placement.generation} · Database links {label(placement.dependencyState)}{" "}
              · App {shouldRun ? label(placement.applicationHealth) : "Stopped"}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">{time(placement.lastObservedAt)}</span>
        </div>
      ))}
    </div>
  );
}

export function AvailabilitySection({
  resource,
  canManage,
  onDisableQueued,
}: {
  resource: DockerAvailabilityResource;
  canManage: boolean;
  onDisableQueued?: (survivor: { nodeId: string; nodeSlug: string }) => void;
}) {
  const [policy, setPolicy] = useState<DockerAvailabilityPolicy | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [mode, setMode] = useState<Exclude<DockerAvailabilityMode, "single">>("replicated");
  const [replicas, setReplicas] = useState("2");
  const [selectionMode, setSelectionMode] = useState<"all_compatible" | "selected">(
    "all_compatible"
  );
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [graceSeconds, setGraceSeconds] = useState("15");
  const [maxUnavailable, setMaxUnavailable] = useState("0");
  const [maxSurge, setMaxSurge] = useState("1");
  const [drainSeconds, setDrainSeconds] = useState("30");
  const [disableOpen, setDisableOpen] = useState(false);
  const [survivorId, setSurvivorId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [enablePreviewOpen, setEnablePreviewOpen] = useState(false);
  const dirtyRef = useRef(false);
  const stableResource = useStableAvailabilityResource(resource);

  const load = useCallback(
    async (preserveDraft = dirtyRef.current) => {
      try {
        const [nextPolicy, nodeResult] = await Promise.all([
          api.getDockerAvailability(stableResource),
          api.listNodes({ type: "docker", limit: 100 }),
        ]);
        setPolicy(nextPolicy);
        setNodes(nodeResult.data);
        const syncDraft = !preserveDraft || !nextPolicy || nextPolicy.status === "disabling";
        if (syncDraft) {
          setEnabledDraft(
            Boolean(nextPolicy && nextPolicy.mode !== "single" && nextPolicy.status !== "disabling")
          );
          if (nextPolicy) {
            setMode(nextPolicy.mode === "failover" ? "failover" : "replicated");
            setReplicas(
              String(
                nextPolicy.mode === "single"
                  ? 2
                  : nextPolicy.mode === "failover"
                    ? 1
                    : nextPolicy.desiredReplicaCount
              )
            );
            setSelectionMode(
              nextPolicy.mode === "single" ? "all_compatible" : nextPolicy.nodeSelectionMode
            );
            setSelectedNodeIds(nextPolicy.mode === "single" ? [] : nextPolicy.selectedNodeIds);
            setGraceSeconds(String(nextPolicy.offlineReplacementGraceSeconds));
            setMaxUnavailable(String(nextPolicy.rolloutPolicy.maxUnavailable));
            setMaxSurge(String(nextPolicy.rolloutPolicy.maxSurge));
            setDrainSeconds(String(nextPolicy.rolloutPolicy.drainSeconds));
          }
        }
      } catch (error) {
        if (!handleLicenseApiError(error, "Availability")) {
          toast.error(error instanceof Error ? error.message : "Failed to load Availability");
        }
      } finally {
        setLoading(false);
      }
    },
    [stableResource]
  );

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("docker.availability.changed", () => void load());
  useRealtime("docker.availability.operation.changed", () => void load());

  const input = useMemo<DockerAvailabilityPolicyInput>(
    () => ({
      resource: stableResource,
      mode,
      desiredReplicaCount: mode === "failover" ? 1 : Math.max(2, Number(replicas) || 2),
      nodeSelectionMode: selectionMode,
      selectedNodeIds: selectionMode === "selected" ? selectedNodeIds : [],
      rolloutPolicy: {
        maxUnavailable: Math.min(32, Math.max(0, Number(maxUnavailable) || 0)),
        maxSurge: Math.min(32, Math.max(0, Number(maxSurge) || 0)),
        drainSeconds: Math.min(3600, Math.max(0, Number(drainSeconds) || 0)),
      },
      offlineReplacementGraceSeconds: Math.max(0, Number(graceSeconds) || 0),
    }),
    [
      drainSeconds,
      graceSeconds,
      maxSurge,
      maxUnavailable,
      mode,
      replicas,
      stableResource,
      selectedNodeIds,
      selectionMode,
    ]
  );
  const compatibleNodeIds = new Set(
    nodes
      .filter((node) => node.status === "online" && node.type === "docker")
      .map((node) => node.id)
  );
  const servingPlacements = policy?.placements.filter((placement) => placement.serving).length ?? 0;
  const desiredServing =
    policy?.mode === "replicated"
      ? policy.desiredReplicaCount
      : policy?.mode === "failover"
        ? 1
        : 1;
  const activePlacements =
    policy?.placements.filter((placement) => placement.actualState !== "removed") ?? [];
  const enabled = Boolean(policy && policy.mode !== "single" && policy.status !== "disabling");
  const disabling = policy?.status === "disabling";
  const displayStatus =
    policy && policy.mode !== "single"
      ? resolveAvailabilitySurfaceStatus({
          policyStatus: policy.status,
          operation: policy.latestOperation,
          shouldRun: policy.shouldRun,
          serving: servingPlacements,
          desired: desiredServing,
        })
      : policy?.status;
  const configurationDirty =
    enabled &&
    policy !== null &&
    (mode !== policy.mode ||
      (mode === "replicated" && Number(replicas) !== policy.desiredReplicaCount) ||
      selectionMode !== policy.nodeSelectionMode ||
      JSON.stringify(selectionMode === "selected" ? [...selectedNodeIds].sort() : []) !==
        JSON.stringify([...policy.selectedNodeIds].sort()) ||
      Number(graceSeconds) !== policy.offlineReplacementGraceSeconds ||
      Number(maxUnavailable) !== policy.rolloutPolicy.maxUnavailable ||
      Number(maxSurge) !== policy.rolloutPolicy.maxSurge ||
      Number(drainSeconds) !== policy.rolloutPolicy.drainSeconds);
  const dirty = enabledDraft !== enabled || (enabledDraft && configurationDirty);
  dirtyRef.current = dirty;

  function issueDescription(items: DockerAvailabilityIssue[]) {
    return items
      .map((issue) =>
        issue.nodeId ? `${nodeName(issue.nodeId, nodes)}: ${issue.message}` : issue.message
      )
      .join(" · ");
  }

  async function preflight(notifySuccess = true) {
    setChecking(true);
    try {
      const result = await api.preflightDockerAvailability(input);
      if (result.blockers.length > 0) {
        toast.error("Availability check failed", {
          description: issueDescription(result.blockers),
        });
        return false;
      }
      if (notifySuccess && result.warnings.length > 0) {
        toast.warning("Availability check passed with warnings", {
          description: issueDescription(result.warnings),
        });
      } else if (notifySuccess) {
        toast.success("Availability preflight passed");
      }
      return result.eligible;
    } catch (error) {
      if (!handleLicenseApiError(error, "Availability")) {
        toast.error(error instanceof Error ? error.message : "Availability preflight failed");
      }
      return false;
    } finally {
      setChecking(false);
    }
  }

  async function save(previewConfirmed = false) {
    if (!canManage || !requireLicenseFeature("multi-node-availability", "Availability")) return;
    if (!dirty) return;
    if (!enabled && enabledDraft && !previewConfirmed) {
      setEnablePreviewOpen(true);
      return;
    }
    if (enabled && !enabledDraft) {
      setSurvivorId(
        policy?.placements.find((placement) => canKeepPlacement(placement, policy.shouldRun))?.id ??
          ""
      );
      setConfirmation("");
      setDisableOpen(true);
      return;
    }
    setSaving(true);
    try {
      if (!(await preflight(false))) return;
      if (enabled && policy) {
        const { resource: _resource, ...update } = input;
        await api.updateDockerAvailability(policy.id, update);
        toast.success("Availability update queued");
      } else {
        await api.enableDockerAvailability(input);
        toast.success("Availability enablement queued");
      }
      dirtyRef.current = false;
      await load(false);
    } catch (error) {
      if (!handleLicenseApiError(error, "Availability")) {
        toast.error(error instanceof Error ? error.message : "Failed to update Availability");
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PanelShell
        title={
          <span className="inline-flex flex-wrap items-center gap-2" aria-label="Availability">
            <span>Availability</span>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge size="inline" variant="warning" tabIndex={0}>
                    Tech Preview
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm break-words">
                  Availability is available as a Tech Preview. Not all scenarios and edge cases have
                  been verified, and the feature may be unstable. Validate it with your own workload
                  before using it.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {policy && displayStatus && policy.mode !== "single" ? (
              <StatusBadge status={displayStatus} error={policy.lastErrorMessage} />
            ) : null}
          </span>
        }
        icon={<ShieldCheck className="h-4 w-4" />}
        description={
          policy && policy.mode !== "single"
            ? policy.shouldRun
              ? `${label(policy.mode)} · ${servingPlacements}/${desiredServing} serving`
              : `${label(policy.mode)} · Stopped`
            : "Run this workload on independent Docker nodes without opening cluster ports."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={checking || saving}
              onClick={() => void preflight()}
            >
              {checking && <RefreshCw className="animate-spin" />} Check eligibility
            </Button>
            <Button
              disabled={!canManage || checking || saving || !dirty}
              onClick={() => void save()}
            >
              <Save />
              Save
            </Button>
          </div>
        }
        wrapHeader
        dirty={dirty}
      >
        <SettingsControlRow
          title="Enable"
          description="Run this logical workload across independent Docker nodes."
          help="Availability requires at least two online compatible Docker nodes. Changes are applied only after Save."
        >
          <Switch
            checked={enabledDraft}
            onChange={setEnabledDraft}
            disabled={
              !canManage ||
              saving ||
              checking ||
              disabling ||
              (!enabled && compatibleNodeIds.size < 2)
            }
            ariaLabel="Enable Availability"
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Mode"
          description="Choose simultaneous replicas or automatic failover."
          help="Replicated serves traffic from multiple nodes at the same time. Failover keeps one serving placement and creates a replacement after the active node becomes unavailable."
        >
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as typeof mode)}
            disabled={!canManage || !enabledDraft}
          >
            <SelectTrigger aria-label="Availability mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value="replicated"
                description="Serve traffic from multiple nodes at the same time."
              >
                Replicated
              </SelectItem>
              <SelectItem
                value="failover"
                description="Keep one serving placement and replace it after node loss."
              >
                Failover
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsControlRow>
        {mode === "replicated" && (
          <SettingsControlRow
            title="Serving placements"
            description="Fixed replica count, one placement per node."
            help="The desired number of simultaneously serving placements. Each placement runs on a different eligible Docker node."
          >
            <Input
              aria-label="Serving placements"
              type="number"
              min={2}
              max={32}
              value={replicas}
              onChange={(event) => setReplicas(event.target.value)}
              disabled={!canManage || !enabledDraft}
            />
          </SettingsControlRow>
        )}
        <SettingsControlRow
          title="Eligible nodes"
          description="Use every compatible node or keep an explicit allowlist."
          help="All compatible nodes lets Gateway place the workload on any online Docker node that passes eligibility checks. Selected nodes restricts placement to the explicit allowlist."
        >
          <Select
            value={selectionMode}
            onValueChange={(value) => setSelectionMode(value as typeof selectionMode)}
            disabled={!canManage || !enabledDraft}
          >
            <SelectTrigger aria-label="Eligible node selection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all_compatible">All compatible nodes</SelectItem>
              <SelectItem value="selected">Selected nodes</SelectItem>
            </SelectContent>
          </Select>
        </SettingsControlRow>
        {selectionMode === "selected" && (
          <div className="grid gap-2 border-b border-border px-4 py-3 sm:grid-cols-2">
            {nodes
              .filter((node) => node.type === "docker")
              .map((node) => {
                const checked = selectedNodeIds.includes(node.id);
                const compatible = compatibleNodeIds.has(node.id);
                return (
                  <label
                    key={node.id}
                    className="flex min-w-0 items-center gap-2 border border-border px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="form-checkbox shrink-0"
                      checked={checked}
                      disabled={!canManage || !enabledDraft || (!compatible && !checked)}
                      onChange={() =>
                        setSelectedNodeIds((current) =>
                          checked ? current.filter((id) => id !== node.id) : [...current, node.id]
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {node.displayName || node.hostname || node.slug}
                    </span>
                    <Badge size="inline" variant={compatible ? "success" : "secondary"}>
                      {compatible ? "Eligible" : label(node.status)}
                    </Badge>
                  </label>
                );
              })}
          </div>
        )}
        <SettingsControlRow
          title="Replacement grace"
          description="Wait briefly for a disconnected node before creating a replacement."
          help="Gateway waits this many seconds after losing the node control connection before it creates a replacement on another eligible node."
        >
          <Input
            aria-label="Replacement grace in seconds"
            type="number"
            min={0}
            max={3600}
            value={graceSeconds}
            onChange={(event) => setGraceSeconds(event.target.value)}
            disabled={!canManage || !enabledDraft}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Maximum unavailable"
          description="Limit how many serving placements a planned rollout may take out at once."
          help="The maximum number of desired placements that a planned update may leave unavailable at the same time. Zero preserves the full serving count during rollout."
        >
          <Input
            aria-label="Maximum unavailable placements"
            type="number"
            min={0}
            max={32}
            value={maxUnavailable}
            onChange={(event) => setMaxUnavailable(event.target.value)}
            disabled={!canManage || !enabledDraft}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Maximum surge"
          description="Allow temporary placements when a zero-unavailable rollout needs spare capacity."
          help="The maximum number of temporary placements Gateway may create above the desired count while performing a planned rollout."
        >
          <Input
            aria-label="Maximum surge placements"
            type="number"
            min={0}
            max={32}
            value={maxSurge}
            onChange={(event) => setMaxSurge(event.target.value)}
            disabled={!canManage || !enabledDraft}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Drain interval"
          description="Stop sending new connections before a planned placement removal."
          help="Gateway removes the placement from routing, waits this many seconds for existing connections to drain, and then stops the placement."
        >
          <Input
            aria-label="Drain interval in seconds"
            type="number"
            min={0}
            max={3600}
            value={drainSeconds}
            onChange={(event) => setDrainSeconds(event.target.value)}
            disabled={!canManage || !enabledDraft}
          />
        </SettingsControlRow>
      </PanelShell>

      {policy && policy.mode !== "single" && (
        <PanelShell
          title={
            <span className="inline-flex items-center gap-2" aria-label="Placements">
              <span>Placements</span>
              <Badge size="inline" variant="secondary">
                {activePlacements.length}
              </Badge>
            </span>
          }
          description="One workload placement per eligible Docker node."
        >
          <PlacementRows
            placements={policy.placements}
            nodes={nodes}
            shouldRun={policy.shouldRun}
          />
        </PanelShell>
      )}

      <Dialog open={enablePreviewOpen} onOpenChange={setEnablePreviewOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Enable Availability Tech Preview?</DialogTitle>
            <DialogDescription>
              Review the Tech Preview limitations before enabling Availability.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Not all scenarios and edge cases have been verified, and the feature may be unstable.
            Validate it with your own workload before using it.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnablePreviewOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setEnablePreviewOpen(false);
                void save(true);
              }}
            >
              Enable Tech Preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Disable Availability</DialogTitle>
            <DialogDescription>
              Select the placement to keep, then type {policy?.displayName} to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <SettingsInlineControl label="Surviving placement">
              <Select value={survivorId} onValueChange={setSurvivorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a placement" />
                </SelectTrigger>
                <SelectContent>
                  {policy?.placements
                    .filter((placement) => canKeepPlacement(placement, policy.shouldRun))
                    .map((placement) => (
                      <SelectItem key={placement.id} value={placement.id}>
                        {nodeName(placement.nodeId, nodes)} · {label(placement.actualState)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </SettingsInlineControl>
            <SettingsInlineControl label={`Type ${policy?.displayName ?? "the workload name"}`}>
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </SettingsInlineControl>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!policy || !survivorId || confirmation !== policy.displayName || saving}
              onClick={async () => {
                if (!policy) return;
                setSaving(true);
                try {
                  const nextPolicy = await api.disableDockerAvailability(policy.id, {
                    survivingPlacementId: survivorId,
                    confirmation,
                  });
                  const survivorPlacement = policy.placements.find(
                    (placement) => placement.id === survivorId
                  );
                  const survivorNode = nodes.find((node) => node.id === survivorPlacement?.nodeId);
                  setPolicy(nextPolicy);
                  toast.success("Availability disablement queued");
                  setDisableOpen(false);
                  setEnabledDraft(false);
                  if (survivorPlacement && survivorNode?.slug) {
                    onDisableQueued?.({
                      nodeId: survivorPlacement.nodeId,
                      nodeSlug: survivorNode.slug,
                    });
                  }
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : "Failed to disable Availability"
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              Disable and keep one
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
