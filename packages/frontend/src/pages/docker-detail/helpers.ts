import { toast } from "sonner";
import type { DockerGpuAttachment } from "@/types";

export const STATUS_BADGE: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  running: "success",
  exited: "secondary",
  stopped: "secondary",
  paused: "warning",
  dead: "destructive",
  starting: "warning",
  restarting: "warning",
  stopping: "warning",
  recreating: "warning",
  updating: "warning",
  migrating: "warning",
  killing: "warning",
  deploying: "warning",
  switching: "warning",
  rolling_back: "warning",
  enabling: "warning",
  scaling: "warning",
  rolling_out: "warning",
  disabling: "warning",
  healthy: "success",
  unavailable: "destructive",
  failed: "destructive",
  removing: "warning",
  created: "secondary",
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
  disabled: "secondary",
};

export function containerDisplayName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

export function containerLifecycleActions(state: string) {
  const normalizedState = state.toLowerCase();
  const isRunning = normalizedState === "running";
  const isRestarting = normalizedState === "restarting";

  return {
    canStart: ["created", "exited", "stopped"].includes(normalizedState),
    canStop: isRunning || isRestarting,
    canRestart: isRunning,
    // Kill is the emergency escape hatch for every live or transitional state.
    // In particular, it must remain available while update/recreate is stuck.
    canKill: !["created", "exited", "offline"].includes(normalizedState),
  };
}

export function containerArchiveCapabilities(scopes: {
  export: boolean;
  files: boolean;
  environment: boolean;
  secrets: boolean;
}) {
  return {
    canExport: scopes.export,
    canExportPortable: scopes.export && scopes.files,
    canIncludeEnvironment: scopes.environment,
    canIncludeSecrets: scopes.environment && scopes.secrets,
  };
}

export function formatDate(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleString();
}

export { formatBytes } from "@/lib/utils";

export function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("Copied to clipboard"),
    () => toast.error("Failed to copy")
  );
}

export type InspectData = Record<string, any> & {
  nodeId?: string;
  availability?: "available" | "unavailable";
  gpuAttachment?: DockerGpuAttachment;
};
