import { ArrowRight, ArrowUpCircle, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";
import { useRealtime } from "@/hooks/use-realtime";
import { isDevForceUpdatesEnabled } from "@/lib/dev-force-updates";
import { nodeTypeLabel } from "@/lib/node-appearance";
import { dockerNodeListRoute, proxyHostRoute } from "@/lib/resource-routes";
import { deriveAllowedResourceIdsByScope, scopeMatches } from "@/lib/scope-utils";
import { cn, formatBytes, formatUptime } from "@/lib/utils";
import { api } from "@/services/api";
import { authContextKey, useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import {
  type DockerRuntimeStatus,
  getNodeUpdateTargetVersion,
  isNodeUpdating,
  type NodeDetail,
  type NodeHealthReport,
  type ProxyHost,
} from "@/types";
import { HOSTING_PROVIDER_LABELS, type HostingNodeProjection } from "@/types/hosting";

const DOCKER_RESOURCES = [
  {
    tab: "containers",
    label: "containers",
    load: (nodeId: string) => api.listDockerContainerSnapshots({ nodeId }),
  },
  {
    tab: "images",
    label: "images",
    load: (nodeId: string) => api.listDockerImageSnapshots({ nodeId }),
  },
  {
    tab: "volumes",
    label: "volumes",
    load: (nodeId: string) => api.listDockerVolumeSnapshots({ nodeId }),
  },
  {
    tab: "networks",
    label: "networks",
    load: (nodeId: string) => api.listDockerNetworkSnapshots({ nodeId }),
  },
  {
    tab: "compose",
    label: "compose projects",
    load: (nodeId: string) => api.listDockerComposeProjects(nodeId),
  },
] as const;
type DockerResourceTab = (typeof DOCKER_RESOURCES)[number]["tab"];

interface NodeDetailsTabProps {
  hosting?: HostingNodeProjection | null;
  node: NodeDetail;
  canManageSecureRuntime: boolean;
  daemonUpdate: {
    available: boolean;
    latestVersion: string | null;
  };
  refreshNode: () => Promise<void>;
  refreshDaemonUpdateStatus: (options?: { force?: boolean }) => Promise<void>;
}

function normalizeVersion(version: string | null | undefined): string {
  return (version ?? "").replace(/^v/, "");
}

function IPAddressPanel({ title, addresses }: { title: string; addresses: string[] }) {
  return (
    <PanelShell title={title} bodyClassName="divide-y divide-border">
      {addresses.length > 0 ? (
        addresses.map((address) => (
          <div key={address} className="px-4 py-3 text-sm">
            {address}
          </div>
        ))
      ) : (
        <div className="px-4 py-3 text-sm text-muted-foreground">No addresses detected</div>
      )}
    </PanelShell>
  );
}

export function NodeDetailsTab({
  hosting,
  node,
  canManageSecureRuntime,
  daemonUpdate,
  refreshNode,
  refreshDaemonUpdateStatus,
}: NodeDetailsTabProps) {
  const navigate = useNavigate();
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const user = useAuthStore((state) => state.user);
  const authKey = authContextKey(user);
  const dockerResources = useMemo(() => {
    const scopes = user?.scopes ?? [];
    const allowed = deriveAllowedResourceIdsByScope(scopes);
    return DOCKER_RESOURCES.map((resource) => {
      const scope = `docker:${resource.tab}:view`;
      return {
        ...resource,
        canView:
          scopeMatches(scopes, `${scope}:${node.id}`) ||
          (allowed[scope] ?? []).some((id) => id.startsWith(`${node.id}/`)),
      };
    });
  }, [node.id, user?.scopes]);
  const [dockerCounts, setDockerCounts] = useState<Partial<Record<DockerResourceTab, number>>>({});
  const [containerStates, setContainerStates] = useState<{
    running: number;
    stopped: number;
    paused: number;
  } | null>(null);
  const dockerReadGeneration = useRef(0);
  const dockerCountRequests = useRef<Partial<Record<DockerResourceTab, number>>>({});
  const dockerCountIdentity = useRef({ nodeId: node.id, authKey });
  dockerCountIdentity.current = { nodeId: node.id, authKey };
  const refreshDockerCounts = useCallback(
    async (kind?: string) => {
      if (node.type !== "docker") return;
      const generation = dockerReadGeneration.current;
      await Promise.all(
        dockerResources
          .filter((resource) => resource.canView && (!kind || resource.tab === kind))
          .map(async (resource) => {
            const request = (dockerCountRequests.current[resource.tab] ?? 0) + 1;
            dockerCountRequests.current[resource.tab] = request;
            try {
              const rows = await resource.load(node.id);
              if (
                generation !== dockerReadGeneration.current ||
                request !== dockerCountRequests.current[resource.tab] ||
                dockerCountIdentity.current.nodeId !== node.id ||
                authKey !== authContextKey(useAuthStore.getState().user)
              )
                return;
              const total =
                (rows[0] as { _listTotal?: number } | undefined)?._listTotal ?? rows.length;
              setDockerCounts((current) => ({ ...current, [resource.tab]: total }));
              if (resource.tab === "containers") {
                const containers = rows as Array<{ state?: string; _listTruncated?: boolean }>;
                setContainerStates(
                  containers.some((container) => container._listTruncated)
                    ? null
                    : {
                        running: containers.filter((container) => container.state === "running")
                          .length,
                        stopped: containers.filter(
                          (container) =>
                            container.state === "exited" || container.state === "stopped"
                        ).length,
                        paused: containers.filter((container) => container.state === "paused")
                          .length,
                      }
                );
              }
            } catch {
              // Keep the last known count on transient refresh failures; never turn an error into zero.
            }
          })
      );
    },
    [authKey, dockerResources, node.id, node.type]
  );
  useEffect(() => {
    dockerReadGeneration.current++;
    setDockerCounts({});
    setContainerStates(null);
    void refreshDockerCounts();
    return () => {
      dockerReadGeneration.current++;
    };
  }, [refreshDockerCounts]);
  useRealtime(
    node.type === "docker" ? "docker.snapshot.changed" : null,
    (payload) => {
      const event = payload as { nodeId?: string; kind?: string };
      if (event.nodeId === node.id) void refreshDockerCounts(event.kind);
    },
    { onReconnect: () => void refreshDockerCounts() }
  );
  useRealtime(node.type === "docker" ? "docker.compose.changed" : null, (payload) => {
    const event = payload as { nodeId?: string };
    if (event.nodeId === node.id) void refreshDockerCounts("compose");
  });
  const [isUpdating, setIsUpdating] = useState(false);
  const [pendingUpdateTarget, setPendingUpdateTarget] = useState<string | null>(null);
  const [ipAddressesOpen, setIpAddressesOpen] = useState(false);
  const h: NodeHealthReport | null = node.liveHealthReport ?? node.lastHealthReport;
  const caps = (node.capabilities ?? {}) as Record<string, unknown>;
  const reportedRuntimeStatus = caps.dockerRuntimeStatus as DockerRuntimeStatus | undefined;
  const [runtimeStatus, setRuntimeStatus] = useState<DockerRuntimeStatus | undefined>(
    reportedRuntimeStatus
  );
  const [runtimeAction, setRuntimeAction] = useState<"preflight" | "install" | null>(null);
  const nodeUpdating = isNodeUpdating(node);
  // A live NodeControl stream is sufficient to deliver the update even when
  // the daemon and the new generic tunnel protocol do not match yet.
  const canTriggerDaemonUpdate = node.status === "online" && node.isConnected;
  const updateTargetVersion = getNodeUpdateTargetVersion(node);
  const localIpAddresses = Array.from(new Set(h?.localIpAddresses ?? [])).sort();
  const publicIpAddresses = Array.from(new Set(h?.publicIpAddresses ?? [])).sort();
  const ipAddressCount = new Set([...localIpAddresses, ...publicIpAddresses]).size;
  const resourcesRef = useRef<HTMLDivElement>(null);
  const [resourcesHeight, setResourcesHeight] = useState(0);

  useEffect(() => {
    setRuntimeStatus(reportedRuntimeStatus);
  }, [reportedRuntimeStatus]);

  useEffect(() => {
    if (runtimeAction !== "install" && runtimeStatus?.state !== "installing") return;
    void refreshNode().catch(() => undefined);
    const interval = window.setInterval(() => {
      void refreshNode().catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [refreshNode, runtimeAction, runtimeStatus?.state]);

  useEffect(() => {
    if (!resourcesRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setResourcesHeight(entry.contentRect.height + 2); // +2 for border
    });
    ro.observe(resourcesRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!pendingUpdateTarget) return;
    const current = normalizeVersion(node.daemonVersion);
    const target = normalizeVersion(pendingUpdateTarget);
    if ((target && current === target) || !daemonUpdate.available) {
      setPendingUpdateTarget(null);
    }
  }, [daemonUpdate.available, node.daemonVersion, pendingUpdateTarget]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (node.type === "nginx") {
        if (node.status !== "online" || !node.isConnected) {
          setProxyHosts([]);
          return;
        }
        try {
          const resp = await api.listProxyHosts({ nodeId: node.id, limit: 100 });
          if (!cancelled) setProxyHosts(resp.data ?? []);
        } catch {
          if (!cancelled) setProxyHosts([]);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [node.id, node.isConnected, node.status, node.type]);

  const handleDaemonUpdate = async () => {
    if (isDevForceUpdatesEnabled()) {
      toast.info("Local update preview only");
      return;
    }
    setIsUpdating(true);
    const targetVersion = daemonUpdate.latestVersion;
    try {
      await api.triggerDaemonUpdate(node.id);
      if (targetVersion) setPendingUpdateTarget(targetVersion);
      toast.success("Daemon update triggered — the node will restart shortly");
      await Promise.all([refreshNode(), refreshDaemonUpdateStatus({ force: true })]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to trigger update");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRuntimeAction = async (action: "preflight" | "install") => {
    if (!requireLicenseFeature("secure-runtime", "Secure Runtime setup")) return;
    setRuntimeAction(action);
    try {
      const status =
        action === "install"
          ? await api.installDockerRuntime(node.id)
          : await api.preflightDockerRuntime(node.id);
      setRuntimeStatus(status);
      toast.success(
        action === "install" ? "Secure runtime installed" : "Compatibility check completed"
      );
      await refreshNode();
    } catch (err) {
      if (!handleLicenseApiError(err, "Secure Runtime setup")) {
        toast.error(err instanceof Error ? err.message : "Secure runtime setup failed");
      }
    } finally {
      setRuntimeAction(null);
    }
  };

  const runtimeInstalling = runtimeAction === "install" || runtimeStatus?.state === "installing";

  return (
    <div className="space-y-4">
      {(hosting || node.type === "docker") && (
        <div
          className={cn(
            "grid grid-cols-1 gap-4",
            hosting && node.type === "docker" && "min-[1044px]:grid-cols-2"
          )}
        >
          {node.type === "docker" && (
            <PanelShell title="Docker" bodyClassName="divide-y divide-border">
              {dockerResources.map((resource) => (
                <DetailRow
                  key={resource.tab}
                  label={`${resource.canView ? (dockerCounts[resource.tab] ?? "—") : "—"} ${resource.label}`}
                  value={
                    resource.canView ? (
                      <Button asChild variant="link" className="h-auto p-0">
                        <Link to={dockerNodeListRoute(node.id, resource.tab)}>
                          View {resource.label}
                          <ArrowRight data-icon="inline-end" />
                        </Link>
                      </Button>
                    ) : (
                      "No access"
                    )
                  }
                />
              ))}
            </PanelShell>
          )}
          {hosting && (
            <PanelShell title="Hosting" bodyClassName="divide-y divide-border">
              <DetailRow
                label="Provider"
                value={`${HOSTING_PROVIDER_LABELS[hosting.provider]} · ${hosting.connectorName ?? "Disconnected account"}`}
              />
              <DetailRow
                label="Resource"
                value={
                  hosting.resourceId
                    ? `${hosting.kind.toUpperCase()} ${hosting.remoteId} · ${hosting.location}`
                    : "Waiting for provider VM"
                }
              />
              <DetailRow
                label="Resources"
                value={`${hosting.cpu ?? "—"} vCPU · ${hosting.memoryMb ?? "—"} MiB RAM · ${hosting.diskGb ?? "—"} GiB disk`}
              />
              {hosting.provider === "proxmox" && (
                <DetailRow label="Ownership" value={hosting.origin} />
              )}
              <DetailRow label="Updated" value={new Date(hosting.observedAt).toLocaleString()} />
              {hosting.price && (
                <DetailRow
                  label={hosting.price.estimated ? "Estimated cost" : "Cost"}
                  value={`${hosting.price.amount} ${hosting.price.currency} / ${hosting.price.period ?? "billing period"}`}
                />
              )}
              {hosting.identityConflict && (
                <DetailRow
                  label="Management"
                  value="Provider resource identity changed. Remote actions are disabled."
                />
              )}
            </PanelShell>
          )}
        </div>
      )}

      {node.type === "docker" && (
        <PanelShell
          role="region"
          aria-label="Container summary"
          bodyClassName="grid grid-cols-4 divide-x divide-border"
        >
          {[
            { label: "Running", count: containerStates?.running },
            { label: "Stopped", count: containerStates?.stopped },
            { label: "Paused", count: containerStates?.paused },
            { label: "Total", count: dockerCounts.containers },
          ].map((item) => (
            <div key={item.label} className="p-4 text-center">
              <p className="text-2xl font-bold">
                {dockerResources[0].canView ? (item.count ?? "—") : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
            </div>
          ))}
        </PanelShell>
      )}

      {!nodeUpdating && daemonUpdate.available && !pendingUpdateTarget && (
        <PanelShell
          title={<span className="text-warning">Update Available</span>}
          description={`${daemonUpdate.latestVersion} is ready to install`}
          dirty
          actions={
            <Button
              className="bg-warning text-black hover:bg-warning/90 disabled:opacity-50"
              onClick={handleDaemonUpdate}
              disabled={isUpdating || !canTriggerDaemonUpdate}
              title={
                canTriggerDaemonUpdate
                  ? undefined
                  : "Daemon update requires a connected compatible node"
              }
            >
              <ArrowUpCircle className="h-3.5 w-3.5" />
              Update to {daemonUpdate.latestVersion}
            </Button>
          }
        >
          <div className="divide-y divide-border">
            <DetailRow label="Current version" value={node.daemonVersion ?? "Unknown"} />
            <DetailRow label="New version" value={daemonUpdate.latestVersion ?? "Unknown"} />
          </div>
        </PanelShell>
      )}

      {node.type === "docker" && runtimeStatus?.state !== "healthy" && (
        <PanelShell
          title="Secure Runtime Setup"
          description={
            runtimeInstalling
              ? "Installing and verifying Secure Runtime"
              : runtimeStatus?.message || "Check this node for gVisor compatibility"
          }
          actions={
            !canManageSecureRuntime ? null : runtimeInstalling ? (
              <Button disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Setting up...
              </Button>
            ) : (runtimeStatus?.state === "installable" || runtimeStatus?.state === "failed") &&
              runtimeStatus.remoteInstallable ? (
              <Button
                onClick={() => handleRuntimeAction("install")}
                disabled={runtimeAction !== null || node.status !== "online" || !node.isConnected}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {runtimeStatus.state === "failed" ? "Retry setup" : "Setup"}
              </Button>
            ) : runtimeStatus?.state !== "unsupported" ? (
              <Button
                variant="outline"
                onClick={() => handleRuntimeAction("preflight")}
                disabled={runtimeAction !== null || node.status !== "online" || !node.isConnected}
              >
                {runtimeAction === "preflight" ? "Checking..." : "Check compatibility"}
              </Button>
            ) : null
          }
        >
          <div className="divide-y divide-border">
            <DetailRow
              label="Status"
              value={
                <Badge variant={runtimeStatus?.state === "unsupported" ? "secondary" : "warning"}>
                  {runtimeInstalling ? "installing" : (runtimeStatus?.state ?? "unknown")}
                </Badge>
              }
            />
            {runtimeInstalling && runtimeStatus?.message && (
              <DetailRow label="Step" value={runtimeStatus.message} />
            )}
            {runtimeStatus?.step === "downloading" &&
              runtimeStatus.progressPercent !== undefined && (
                <DetailRow
                  label="Download"
                  value={
                    <span className="flex w-full max-w-xs items-center gap-3">
                      <ProgressBar
                        value={runtimeStatus.progressPercent}
                        aria-label="gVisor download progress"
                      />
                      <span className="w-10 shrink-0 text-right tabular-nums">
                        {runtimeStatus.progressPercent}%
                      </span>
                    </span>
                  }
                />
              )}
            {runtimeStatus?.localInstallCommand && !runtimeStatus.remoteInstallable && (
              <DetailRow
                label="Local setup"
                value={
                  <span className="font-mono text-xs">{runtimeStatus.localInstallCommand}</span>
                }
              />
            )}
          </div>
        </PanelShell>
      )}

      {/* Node Details — 2 cards side by side */}
      <div className="grid grid-cols-1 gap-4 min-[1044px]:grid-cols-2">
        {/* Identity */}
        <PanelShell
          title="Identity"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow label="Node ID" value={<span className="break-all">{node.id}</span>} />
          <DetailRow label="Hostname" value={node.hostname} />
          <DetailRow
            label="Type"
            value={
              <Badge variant="secondary" className="uppercase">
                {nodeTypeLabel(node.type)}
              </Badge>
            }
          />
          {node.osInfo && <DetailRow label="OS" value={node.osInfo} />}
          <DetailRow
            label="IP Addresses"
            value={
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => setIpAddressesOpen(true)}
              >
                View {ipAddressCount} {ipAddressCount === 1 ? "address" : "addresses"}
              </Button>
            }
          />
        </PanelShell>

        {/* Runtime */}
        <PanelShell
          title="Runtime"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Daemon Version"
            value={
              <div className="flex items-center gap-2">
                {node.daemonVersion ? (
                  <Badge variant="secondary" className="uppercase">
                    {node.daemonVersion}
                  </Badge>
                ) : (
                  "Unknown"
                )}
                {(caps.versionMismatch as boolean) && <Badge variant="warning">Mismatch</Badge>}
                {nodeUpdating && (
                  <Badge variant="warning">
                    Updating{updateTargetVersion ? ` to ${updateTargetVersion}` : ""}
                  </Badge>
                )}
              </div>
            }
          />
          {node.type === "nginx" && (
            <DetailRow label="Nginx Version" value={String(caps.nginxVersion ?? "Unknown")} />
          )}
          {node.type === "docker" && (
            <DetailRow label="Docker Version" value={String(caps.dockerVersion ?? "Unknown")} />
          )}
          {node.type === "docker" && runtimeStatus && (
            <DetailRow
              label="Secure Runtime"
              value={
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      runtimeStatus.state === "healthy"
                        ? "success"
                        : runtimeStatus.state === "failed"
                          ? "destructive"
                          : runtimeStatus.state === "unsupported"
                            ? "secondary"
                            : "warning"
                    }
                    className="uppercase"
                  >
                    {runtimeStatus.state}
                  </Badge>
                  {runtimeStatus.installedVersion && (
                    <Badge variant="secondary">{runtimeStatus.installedVersion}</Badge>
                  )}
                </div>
              }
            />
          )}
          <DetailRow label="Created" value={new Date(node.createdAt).toLocaleString()} />
          <DetailRow
            label="Last Seen"
            value={node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "Never"}
          />
        </PanelShell>
      </div>

      {/* System Stats */}
      {h && (
        <div className="grid grid-cols-1 gap-4 min-[1044px]:grid-cols-2 min-[1044px]:items-start">
          {/* Resources */}
          <div
            ref={(el) => {
              if (el) resourcesRef.current = el;
            }}
          >
            <PanelShell title="System Information" bodyClassName="divide-y divide-border">
              {"cpuModel" in caps && <DetailRow label="CPU" value={String(caps.cpuModel)} />}
              {"cpuCores" in caps && <DetailRow label="CPU Cores" value={String(caps.cpuCores)} />}
              {"architecture" in caps && (
                <DetailRow label="Architecture" value={String(caps.architecture)} />
              )}
              {"kernelVersion" in caps && (
                <DetailRow label="Kernel" value={String(caps.kernelVersion)} />
              )}
              <DetailRow label="Uptime" value={formatUptime(h.systemUptimeSeconds)} />
              <DetailRow
                label="File Descriptors"
                value={`${h.openFileDescriptors.toLocaleString()} / ${h.maxFileDescriptors.toLocaleString()}`}
              />
            </PanelShell>
          </div>

          {/* Disk Mounts */}
          <PanelShell
            title="Disk Mounts"
            className="flex flex-col"
            style={{ height: resourcesHeight > 0 ? resourcesHeight : undefined }}
            bodyClassName="flex flex-1 min-h-0 flex-col"
          >
            {h.diskMounts && h.diskMounts.length > 0 ? (
              <div className="overflow-y-auto flex-1 min-h-0 -mb-px">
                {h.diskMounts.map((m) => (
                  <div key={m.mountPoint} className="px-4 py-3 space-y-1 border-b border-border">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono">{m.mountPoint}</span>
                        {m.mountPoint === "/" && (
                          <Badge variant="outline" size="inline">
                            ROOT DISK
                          </Badge>
                        )}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {Math.round(m.usagePercent)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-muted overflow-hidden">
                      <div
                        className={`h-full ${m.usagePercent >= 90 ? "bg-red-400" : m.usagePercent >= 80 ? "bg-warning" : "bg-foreground"}`}
                        style={{ width: `${Math.min(m.usagePercent, 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{formatBytes(m.usedBytes)} used</span>
                      <span>{formatBytes(m.totalBytes)} total</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message="No disk data" embedded />
            )}
          </PanelShell>
        </div>
      )}

      <Dialog open={ipAddressesOpen} onOpenChange={setIpAddressesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>IP Addresses</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <IPAddressPanel title="Public IP Addresses" addresses={publicIpAddresses} />
            <IPAddressPanel title="Local IP Addresses" addresses={localIpAddresses} />
          </div>
        </DialogContent>
      </Dialog>

      {/* Assigned Proxy Hosts — nginx nodes only */}
      {node.type === "nginx" && (
        <PanelShell
          title="Assigned Routes"
          actions={<Badge variant="secondary">{proxyHosts.length}</Badge>}
        >
          {proxyHosts.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="p-3 text-xs font-medium text-muted-foreground">Domain</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground">Type</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground">Target</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {proxyHosts.map((host) => (
                    <tr
                      key={host.id}
                      className="hover:bg-accent transition-colors cursor-pointer"
                      onClick={() => navigate(proxyHostRoute(host.slug))}
                    >
                      <td className="p-3 text-sm font-medium">{host.domainNames.join(", ")}</td>
                      <td className="p-3 text-sm text-muted-foreground capitalize">{host.type}</td>
                      <td className="p-3 text-sm text-muted-foreground">
                        <ProxyUpstreamTarget host={host} />
                      </td>
                      <td className="p-3 align-middle">
                        <Badge variant={host.enabled ? "success" : "secondary"}>
                          {host.enabled ? "active" : "disabled"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState message="No routes assigned yet" embedded />
          )}
        </PanelShell>
      )}
    </div>
  );
}
