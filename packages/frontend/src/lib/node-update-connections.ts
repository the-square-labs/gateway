import type { NodeUpdateConnections } from "@/types";

/** Plain words for the classes of connections a daemon update cuts; unknown classes show their name. */
const CUT_CLASS_LABELS: Record<string, string> = {
  raw_stream: "raw streams of older peers",
  postgres_tls: "PostgreSQL links whose TLS this node opens",
  registry: "registry pulls and pushes",
  backup: "backup runs",
  no_handover: "connections that cannot be handed over",
  service_restart: "connections of the whole service restart for the newer launcher",
  uncounted: "all connections of the node",
  handshake: "connections still being set up",
  over_limit: "connections over the handover limit",
  resume_failed: "connections that did not resume",
  busy: "busy connections",
  idle_closed: "idle connections",
  no_socket: "connections the daemon cannot pass on",
  keep_failed: "connections the daemon could not pass on",
  revoked: "connections of removed routes",
  local_closed: "connections whose local side closed during the update",
  connector_retired: "connections of a replaced Secure Link connector",
};

/** Monitoring and relay daemons carry no connections an update could keep or cut. */
export function carriesUpdateConnections(nodeType: string): boolean {
  return nodeType !== "monitoring" && nodeType !== "relay";
}

/**
 * Where the node page says what the next daemon update does to open connections: in the Update Available or Update
 * Waiting panel while one is shown, otherwise in the Runtime panel (also with no update available).
 */
export function updateConnectionsPlacement(
  nodeType: string,
  updatePanelShown: boolean
): "update-panel" | "runtime" | null {
  if (!carriesUpdateConnections(nodeType)) return null;
  return updatePanelShown ? "update-panel" : "runtime";
}

export function cutClassLabel(connectionClass: string): string {
  return CUT_CLASS_LABELS[connectionClass] ?? connectionClass.replace(/_/g, " ");
}

function cutEntries(cut: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(cut ?? {}).filter(([, count]) => count > 0);
}

export function cutTotal(cut: Record<string, number> | undefined): number {
  return cutEntries(cut).reduce((total, [, count]) => total + count, 0);
}

/** "raw streams of older peers: 3, backup runs: 1" */
export function describeCut(cut: Record<string, number> | undefined): string {
  return cutEntries(cut)
    .sort((a, b) => b[1] - a[1])
    .map(([connectionClass, count]) => `${cutClassLabel(connectionClass)}: ${count}`)
    .join(", ");
}

/**
 * The connection line of the node's last update: "Kept 61, cut 0", "Kept 0, cut 22 (…)". An update the previous
 * daemon did not count (it handed nothing over, so it cut every connection) says so instead of a number.
 */
export function lastUpdateConnectionsText(connections: {
  kept: number;
  cut: Record<string, number>;
}): string {
  if ((connections.cut?.uncounted ?? 0) > 0) {
    return `Kept ${connections.kept}, cut all connections of the node`;
  }
  const total = cutTotal(connections.cut);
  if (total > 0 && total === (connections.cut?.service_restart ?? 0)) {
    return `Kept ${connections.kept}, cut ${total}: all connections of the node (the whole service restarted for the newer launcher)`;
  }
  return `Kept ${connections.kept}, cut ${total}${total > 0 ? ` (${describeCut(connections.cut)})` : ""}`;
}

/**
 * What an update of the node now does to its open connections, with the reason: kept when the daemon hands them
 * over and nothing would be cut, otherwise how many are cut and why (classes on a second line). Shown also when no
 * update is available, so it always says what the next one will do.
 */
export function updateConnectionsSummary(
  handoverCapable: boolean,
  report: NodeUpdateConnections | null | undefined
): { text: string; detail: string | null } {
  if (!handoverCapable) {
    return {
      text: "Open connections are cut once",
      detail: "This daemon version cannot hand connections over",
    };
  }
  if (!report) {
    return { text: "Not reported yet", detail: "The node reports it while it is connected" };
  }
  if (!report.handoverAvailable) {
    if ((report.cut?.service_restart ?? 0) > 0) {
      return {
        text: "Open connections are cut once",
        detail: "The whole service restarts once to start the newer launcher",
      };
    }
    const reasons = describeCut(report.cut);
    return {
      text: "Open connections are cut once",
      detail: reasons || "The launcher running now cannot keep them",
    };
  }
  const total = cutTotal(report.cut);
  if (total === 0) return { text: "The update keeps connections", detail: null };
  const count = `${total} connection${total === 1 ? "" : "s"} will be cut`;
  if (cutEntries(report.cut).every(([connectionClass]) => connectionClass === "raw_stream")) {
    return { text: `${count} (older peers)`, detail: null };
  }
  return { text: count, detail: describeCut(report.cut) };
}

/** Launcher capabilities a daemon reports since it reports its launcher (2.11.4). */
const LAUNCHER_CAPABILITIES = [
  "launcher_listener_keep_v1",
  "launcher_self_update_v1",
  "launcher_openrc_v1",
];

/**
 * Why the node details show the launcher version as Unknown. A daemon that reports launcher capabilities but no
 * launcher version runs under a launcher process started before launchers reported their version (before 2.11.4):
 * that launcher cannot update itself and stays until the service restarts.
 */
export function launcherVersionUnknownReason(capabilities: unknown): string {
  const reported = Array.isArray(capabilities) ? capabilities : [];
  if (reported.some((capability) => LAUNCHER_CAPABILITIES.includes(String(capability)))) {
    return "Started before 2.11.4: this launcher predates launcher self-update and is replaced when the service restarts";
  }
  return "Not reported: the daemon predates 2.11.4, or its launcher predates 2.11";
}
