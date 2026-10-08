import type { NodeUpdateConnections } from "@/types";

/** Plain words for the classes of connections a daemon update cuts; unknown classes show their name. */
const CUT_CLASS_LABELS: Record<string, string> = {
  raw_stream: "raw streams of older peers",
  postgres_tls: "PostgreSQL links whose TLS this node opens",
  registry: "registry pulls and pushes",
  backup: "backup runs",
  no_handover: "connections that cannot be handed over",
  handshake: "connections still being set up",
  over_limit: "connections over the handover limit",
  resume_failed: "connections that did not resume",
  busy: "busy connections",
  idle_closed: "idle connections",
  no_socket: "connections the daemon cannot pass on",
  keep_failed: "connections the daemon could not pass on",
  revoked: "connections of removed routes",
};

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
 * What an update of the node now does to its open connections: kept when the daemon hands them over and nothing
 * would be cut, otherwise how many are cut and why (classes on a second line).
 */
export function updateConnectionsSummary(
  handoverCapable: boolean,
  report: NodeUpdateConnections | null | undefined
): { text: string; detail: string | null } {
  if (!handoverCapable || !report?.handoverAvailable) {
    return { text: "Open connections are cut once", detail: null };
  }
  const total = cutTotal(report.cut);
  if (total === 0) return { text: "The update keeps connections", detail: null };
  const count = `${total} connection${total === 1 ? "" : "s"} will be cut`;
  if (cutEntries(report.cut).every(([connectionClass]) => connectionClass === "raw_stream")) {
    return { text: `${count} (older peers)`, detail: null };
  }
  return { text: count, detail: describeCut(report.cut) };
}
