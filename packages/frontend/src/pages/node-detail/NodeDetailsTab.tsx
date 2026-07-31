import { ArrowUpCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isDevForceUpdatesEnabled } from "@/lib/dev-force-updates";
import { proxyHostRoute } from "@/lib/resource-routes";
import { formatBytes, formatUptime } from "@/lib/utils";
import { api } from "@/services/api";
import {
  type DockerContainer,
  getNodeUpdateTargetVersion,
  isNodeUpdating,
  type NodeDetail,
  type NodeHealthReport,
  type ProxyHost,
} from "@/types";

interface NodeDetailsTabProps {
  node: NodeDetail;
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
  node,
  daemonUpdate,
  refreshNode,
  refreshDaemonUpdateStatus,
}: NodeDetailsTabProps) {
  const navigate = useNavigate();
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[]>([]);
  const [dockerContainersLoading, setDockerContainersLoading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [pendingUpdateTarget, setPendingUpdateTarget] = useState<string | null>(null);
  const [ipAddressesOpen, setIpAddressesOpen] = useState(false);
  const h: NodeHealthReport | null = node.liveHealthReport ?? node.lastHealthReport;
  const caps = (node.capabilities ?? {}) as Record<string, unknown>;
  const nodeUpdating = isNodeUpdating(node);
  const canTriggerDaemonUpdate =
    node.status === "online" && node.isConnected && caps.versionMismatch !== true;
  const updateTargetVersion = getNodeUpdateTargetVersion(node);
  const localIpAddresses = Array.from(new Set(h?.localIpAddresses ?? [])).sort();
  const publicIpAddresses = Array.from(new Set(h?.publicIpAddresses ?? [])).sort();
  const ipAddressCount = new Set([...localIpAddresses, ...publicIpAddresses]).size;
  const resourcesRef = useRef<HTMLDivElement>(null);
  const [resourcesHeight, setResourcesHeight] = useState(0);

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
        setDockerContainers([]);
        setDockerContainersLoading(false);
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
      if (node.type === "docker") {
        setProxyHosts([]);
        if (node.status !== "online" || !node.isConnected) {
          setDockerContainers([]);
          setDockerContainersLoading(false);
          return;
        }
        setDockerContainersLoading(true);
        try {
          const data = await api.listDockerContainers(node.id);
          if (!cancelled) setDockerContainers(data ?? []);
        } catch {
          if (!cancelled) setDockerContainers([]);
        } finally {
          if (!cancelled) setDockerContainersLoading(false);
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

  return (
    <div className="space-y-4">
      {/* Docker Container Overview — docker nodes only */}
      {node.type === "docker" && (
        <div className="border border-border bg-card">
          <div className="grid grid-cols-4 divide-x divide-border">
            {[
              {
                label: "Running",
                count: dockerContainers.filter((c) => c.state === "running").length,
              },
              {
                label: "Stopped",
                count: dockerContainers.filter((c) => c.state === "exited" || c.state === "stopped")
                  .length,
              },
              {
                label: "Paused",
                count: dockerContainers.filter((c) => c.state === "paused").length,
              },
              { label: "Total", count: dockerContainers.length },
            ].map((s) => (
              <div key={s.label} className="p-4 text-center">
                <p className="text-2xl font-bold">{dockerContainersLoading ? "..." : s.count}</p>
                <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
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

      {/* Node Details — 2 cards side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Identity */}
        <PanelShell title="Identity" bodyClassName="divide-y divide-border">
          <DetailRow label="Node ID" value={<span className="break-all">{node.id}</span>} />
          <DetailRow label="Hostname" value={node.hostname} />
          <DetailRow
            label="Type"
            value={
              <Badge variant="secondary" className="uppercase">
                {node.type}
              </Badge>
            }
          />
          {node.osInfo && <DetailRow label="OS" value={node.osInfo} />}
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
          <DetailRow label="Created" value={new Date(node.createdAt).toLocaleString()} />
          <DetailRow
            label="Last Seen"
            value={node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "Never"}
          />
        </PanelShell>
      </div>

      {/* System Stats */}
      {h && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:items-start">
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
          title="Assigned Proxy Hosts"
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
            <EmptyState message="No proxy hosts assigned yet" embedded />
          )}
        </PanelShell>
      )}
    </div>
  );
}
