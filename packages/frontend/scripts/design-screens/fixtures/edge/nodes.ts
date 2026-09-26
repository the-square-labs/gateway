import { HttpResponse, http } from "msw";
import type { DaemonUpdateStatus } from "@/types";
import { nodes } from "../nodes";
import { ago } from "../time";
import { wrapped } from "../../handlers";

const byType = (type: string) => nodes.filter((node) => node.type === type);

/**
 * Daemon release status per daemon type. The Docker daemon has a patch release out,
 * so both Docker nodes (still on 2.14.0, see fixtures/nodes.ts) show it in the Status column.
 */
export const daemonUpdates: DaemonUpdateStatus[] = [
  {
    daemonType: "nginx",
    latestVersion: "2.14.0",
    lastCheckedAt: ago(40, "m"),
    nodes: byType("nginx").map((node) => ({
      nodeId: node.id,
      hostname: node.hostname,
      currentVersion: node.daemonVersion ?? "2.14.0",
      updateAvailable: false,
      arch: "amd64",
    })),
  },
  {
    daemonType: "docker",
    latestVersion: "2.14.1",
    lastCheckedAt: ago(40, "m"),
    nodes: byType("docker").map((node) => ({
      nodeId: node.id,
      hostname: node.hostname,
      currentVersion: node.daemonVersion ?? "2.14.0",
      updateAvailable: true,
      arch: "amd64",
    })),
  },
  {
    daemonType: "monitoring",
    latestVersion: "2.14.0",
    lastCheckedAt: ago(40, "m"),
    nodes: nodes
      .filter((node) => !["nginx", "docker"].includes(node.type))
      .map((node) => ({
        nodeId: node.id,
        hostname: node.hostname,
        currentVersion: node.daemonVersion ?? "2.14.0",
        updateAvailable: false,
        arch: "amd64",
      })),
  },
];

/**
 * Node list side requests: hosting bindings (none, the hosts are self-managed) and
 * daemon releases.
 */
export function nodeListHandlers() {
  return [
    http.get("*/api/hosting/node-bindings", () => HttpResponse.json({})),
    http.get("*/api/integrations/hosting", () => HttpResponse.json([])),
    http.get("*/api/system/daemon-updates", () => wrapped(daemonUpdates)),
  ];
}
