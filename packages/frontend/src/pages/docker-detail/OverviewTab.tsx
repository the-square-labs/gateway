import { ClipboardCopy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDisplayImageRef, resolveContainerImageReference } from "@/lib/docker-image-ref";
import { api } from "@/services/api";
import { copyToClipboard, formatDate, type InspectData, STATUS_BADGE } from "./helpers";

export function OverviewTab({
  nodeId,
  containerId,
  data,
}: {
  nodeId: string;
  containerId: string;
  data: InspectData;
}) {
  const transition = data._transition as string | undefined;
  const state = transition ?? data.State?.Status ?? (data.State?.Running ? "running" : "stopped");
  const id = data.Id ?? containerId;
  const image = formatDisplayImageRef(resolveContainerImageReference(data));
  const created = data.Created ?? "";
  const restartPolicy = data.HostConfig?.RestartPolicy?.Name ?? "no";
  const platform = data.Platform ?? "";
  const hostname = (data.Config?.Hostname ?? "") as string;
  const entrypoint = (data.Config?.Entrypoint ?? []) as string[];
  const cmd = (data.Config?.Cmd ?? []) as string[];
  const workingDir = (data.Config?.WorkingDir ?? "") as string;
  const user = (data.Config?.User ?? "") as string;

  // Ports
  const portBindings = (data.HostConfig?.PortBindings ?? {}) as Record<
    string,
    Array<{ HostIp: string; HostPort: string }> | null
  >;
  const ports: Array<{ container: string; host: string }> = [];
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    if (bindings) {
      for (const b of bindings) {
        ports.push({
          container: containerPort,
          host: b.HostPort ? `${b.HostIp || "0.0.0.0"}:${b.HostPort}` : "-",
        });
      }
    }
  }

  // Mounts
  const mounts = (data.Mounts ?? []) as Array<{
    Type: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }>;

  // Networks
  const networkEntries = Object.entries(data.NetworkSettings?.Networks ?? {}) as Array<
    [string, any]
  >;

  // Recent tasks — refresh on inspect cycle and whenever a docker.task event arrives
  const containerName = (data.Name ?? "").replace(/^\//, "");
  const [recentTasks, setRecentTasks] = useState<any[]>([]);
  const refreshTasks = useCallback(() => {
    api
      .listDockerTasks({ nodeId })
      .then((tasks) => {
        const filtered = (tasks ?? [])
          .filter((t) => t.containerId === containerId || t.containerName === containerName)
          .slice(0, 3);
        setRecentTasks(filtered);
      })
      .catch(() => {});
  }, [nodeId, containerId, containerName]);
  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);
  useRealtime("docker.task.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (!ev || ev.nodeId !== nodeId) return;
    refreshTasks();
  });
  // Container state changes (start/stop/recreate) also produce tasks worth showing
  useRealtime("docker.container.changed", (payload) => {
    const ev = payload as { nodeId?: string; name?: string; id?: string; oldId?: string };
    if (!ev || ev.nodeId !== nodeId) return;
    if (ev.id === containerId || ev.oldId === containerId || ev.name === containerName) {
      refreshTasks();
    }
  });

  return (
    <div className="space-y-4 pb-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* General */}
        <PanelShell
          title="General"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Status"
            value={<Badge variant={STATUS_BADGE[state] ?? "secondary"}>{state}</Badge>}
          />
          <DetailRow
            label="Container ID"
            value={
              <button
                type="button"
                className="flex items-center gap-1.5 font-mono hover:text-primary cursor-pointer"
                onClick={() => copyToClipboard(id)}
              >
                {id.slice(0, 12)}
                <ClipboardCopy className="h-3 w-3" />
              </button>
            }
          />
          <DetailRow label="Image" value={<span className="font-mono">{image}</span>} />
          <DetailRow label="Created" value={created ? formatDate(created) : "-"} />
          <DetailRow label="Restart Policy" value={restartPolicy} />
          {platform && <DetailRow label="Platform" value={platform} />}
        </PanelShell>

        {/* Execution */}
        <PanelShell
          title="Execution"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Entrypoint"
            value={
              <span className="font-mono">
                {entrypoint.length > 0 ? entrypoint.join(" ") : "-"}
              </span>
            }
          />
          <DetailRow
            label="Command"
            value={<span className="font-mono">{cmd.length > 0 ? cmd.join(" ") : "-"}</span>}
          />
          <DetailRow
            label="Working Dir"
            value={<span className="font-mono">{workingDir || "-"}</span>}
          />
          <DetailRow label="User" value={<span className="font-mono">{user || "-"}</span>} />
          <DetailRow
            label="Hostname"
            value={<span className="font-mono">{hostname || "-"}</span>}
          />
        </PanelShell>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Ports */}
        <PanelShell
          title="Port Mappings"
          actions={ports.length > 0 ? <Badge variant="secondary">{ports.length}</Badge> : null}
        >
          {ports.length > 0 ? (
            <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border max-h-[calc(2.75rem*3+1px)] overflow-auto">
              {ports.map((p, i) => (
                <DetailRow
                  key={i}
                  label={p.host}
                  value={<span className="font-mono">{p.container}</span>}
                />
              ))}
            </div>
          ) : (
            <EmptyState message="No port mappings" embedded />
          )}
        </PanelShell>

        {/* Networks */}
        <PanelShell
          title="Networks"
          actions={
            networkEntries.length > 0 ? (
              <Badge variant="secondary">{networkEntries.length}</Badge>
            ) : null
          }
        >
          {networkEntries.length > 0 ? (
            <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border max-h-[calc(2.75rem*3+1px)] overflow-auto">
              {networkEntries.map(([name, cfg]) => (
                <DetailRow
                  key={name}
                  label={name}
                  value={<span className="font-mono">{cfg?.IPAddress || "-"}</span>}
                />
              ))}
            </div>
          ) : (
            <EmptyState message="No networks" embedded />
          )}
        </PanelShell>
      </div>

      {/* Mounts */}
      {mounts.length > 0 && (
        <PanelShell
          title="Mounts"
          actions={<Badge variant="secondary">{mounts.length}</Badge>}
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          {mounts.map((m, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3 gap-4">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-mono truncate block">{m.Source}</span>
                <span className="text-xs text-muted-foreground font-mono">→ {m.Destination}</span>
              </div>
              <Badge variant={m.RW ? "success" : "secondary"}>{m.RW ? "RW" : "RO"}</Badge>
            </div>
          ))}
        </PanelShell>
      )}

      {/* Recent Tasks */}
      {recentTasks.length > 0 && (
        <PanelShell
          title="Recent Activity"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          {recentTasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm capitalize">{task.type}</span>
                {task.progress && (
                  <span className="text-sm text-muted-foreground">{task.progress}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    task.status === "succeeded"
                      ? "success"
                      : task.status === "failed"
                        ? "destructive"
                        : task.status === "running"
                          ? "warning"
                          : "secondary"
                  }
                >
                  {task.status}
                </Badge>
                {task.createdAt && (
                  <span className="text-sm text-muted-foreground">
                    {new Date(task.createdAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          ))}
        </PanelShell>
      )}
    </div>
  );
}
