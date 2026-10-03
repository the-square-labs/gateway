import type { Node, NodeDetail, NodeType } from "@/types";

/** Host access a node operator can turn off in the daemon config file on the node. */
export type NodeHostFeature = "console" | "files";

const FEATURES: Record<
  NodeHostFeature,
  { flag: string; marker: string; key: string; label: string }
> = {
  console: {
    flag: "nodeConsoleDisabled",
    marker: "node_console_disabled_v1",
    key: "console.enabled",
    label: "The host console is",
  },
  files: {
    flag: "nodeFilesDisabled",
    marker: "node_files_disabled_v1",
    key: "files.enabled",
    label: "Host file access is",
  },
};

const DAEMON_CONFIG_PATHS: Partial<Record<NodeType, string>> = {
  nginx: "/etc/nginx-daemon/config.yaml",
  docker: "/etc/docker-daemon/config.yaml",
  builder: "/etc/docker-daemon/config.yaml",
  databases: "/etc/docker-daemon/config.yaml",
  storage: "/etc/docker-daemon/config.yaml",
  monitoring: "/etc/monitoring-daemon/config.yaml",
  relay: "/etc/gateway-relay-supervisor/config.yaml",
};

export function isNodeHostFeatureDisabled(
  node: Node | NodeDetail | null | undefined,
  feature: NodeHostFeature
): boolean {
  const capabilities = (node?.capabilities ?? {}) as Record<string, unknown>;
  const { flag, marker } = FEATURES[feature];
  return (
    capabilities[flag] === true ||
    (Array.isArray(capabilities.capabilities) && capabilities.capabilities.includes(marker))
  );
}

/** Why the feature is unavailable and where the node operator turns it back on. */
export function nodeHostFeatureDisabledMessage(
  node: Pick<Node, "type"> | null | undefined,
  feature: NodeHostFeature
): string {
  const { key, label } = FEATURES[feature];
  const path = node ? DAEMON_CONFIG_PATHS[node.type] : undefined;
  const file = path ? `the daemon config (${path})` : "the daemon config file";
  return `${label} disabled in this node's daemon configuration. To enable it, set ${key}: true in ${file} on the node and restart the daemon.`;
}
