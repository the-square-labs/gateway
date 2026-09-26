import type { Node, NodeDetail, NodeHealthReport, NodeMonitoringSnapshot } from "@/types";
import { ago, agoMs, uuid } from "./time";

const GiB = 1024 ** 3;

function health(overrides: Partial<NodeHealthReport> = {}): NodeHealthReport {
  return {
    nginxRunning: true,
    configValid: true,
    nginxUptimeSeconds: 1_209_600,
    workerCount: 4,
    nginxVersion: "1.27.2",
    cpuPercent: 18.4,
    memoryBytes: 212 * 1024 ** 2,
    diskFreeBytes: 61 * GiB,
    timestamp: agoMs(20, "s"),
    loadAverage1m: 0.62,
    loadAverage5m: 0.54,
    loadAverage15m: 0.49,
    systemMemoryTotalBytes: 8 * GiB,
    systemMemoryUsedBytes: 3.4 * GiB,
    systemMemoryAvailableBytes: 4.6 * GiB,
    swapTotalBytes: 2 * GiB,
    swapUsedBytes: 0.1 * GiB,
    systemUptimeSeconds: 3_456_000,
    openFileDescriptors: 1_824,
    maxFileDescriptors: 65_536,
    diskMounts: [
      {
        mountPoint: "/",
        filesystem: "ext4",
        device: "/dev/sda1",
        totalBytes: 100 * GiB,
        usedBytes: 39 * GiB,
        freeBytes: 61 * GiB,
        usagePercent: 39,
      },
    ],
    diskReadBytes: 48 * GiB,
    diskWriteBytes: 112 * GiB,
    networkInterfaces: [
      {
        name: "eth0",
        rxBytes: 812 * GiB,
        txBytes: 1_310 * GiB,
        rxPackets: 912_345_678,
        txPackets: 1_023_456_789,
        rxErrors: 0,
        txErrors: 0,
        ipAddresses: ["10.20.0.11"],
      },
    ],
    localIpAddresses: ["10.20.0.11"],
    publicIpAddresses: ["203.0.113.11"],
    nginxRssBytes: 96 * 1024 ** 2,
    errorRate4xx: 1.2,
    errorRate5xx: 0.04,
    ...overrides,
  };
}

function healthHistory(status = "healthy") {
  return Array.from({ length: 48 }, (_, index) => ({
    ts: ago((48 - index) * 30, "m"),
    status: index === 31 ? "degraded" : status,
  }));
}

function node(seed: number, overrides: Partial<Node> & Pick<Node, "slug" | "type" | "hostname">): Node {
  return {
    id: uuid(1000 + seed),
    displayName: null,
    appearanceColor: null,
    serviceAddresses: [],
    serviceAddress: null,
    status: "online",
    serviceCreationLocked: false,
    daemonVersion: "2.14.0",
    osInfo: "Ubuntu 24.04.1 LTS (x86_64)",
    configVersionHash: "c41f9a0",
    capabilities: {},
    lastSeenAt: ago(12, "s"),
    lastHealthReport: health(),
    lastStatsReport: null,
    healthHistory: healthHistory(),
    metadata: {},
    isConnected: true,
    folderId: null,
    sortOrder: seed,
    createdAt: ago(210, "d"),
    updatedAt: ago(2, "h"),
    ...overrides,
  };
}

export const nodes: Node[] = [
  node(1, {
    slug: "edge-fra-1",
    type: "nginx",
    hostname: "edge-fra-1",
    displayName: "Edge Frankfurt",
    appearanceColor: "blue",
    serviceAddresses: ["203.0.113.11"],
    serviceAddress: "203.0.113.11",
  }),
  node(2, {
    slug: "edge-ams-1",
    type: "nginx",
    hostname: "edge-ams-1",
    displayName: "Edge Amsterdam",
    appearanceColor: "green",
    serviceAddresses: ["203.0.113.24"],
    serviceAddress: "203.0.113.24",
    lastHealthReport: health({ cpuPercent: 9.1, localIpAddresses: ["10.20.1.12"] }),
  }),
  node(3, {
    slug: "apps-1",
    type: "docker",
    hostname: "apps-1",
    displayName: "Apps 1",
    appearanceColor: "purple",
    lastHealthReport: health({ cpuPercent: 41.7, systemMemoryUsedBytes: 11.2 * GiB, systemMemoryTotalBytes: 16 * GiB }),
  }),
  node(4, {
    slug: "apps-2",
    type: "docker",
    hostname: "apps-2",
    displayName: "Apps 2",
    appearanceColor: "orange",
    lastHealthReport: health({ cpuPercent: 27.3, systemMemoryUsedBytes: 7.9 * GiB, systemMemoryTotalBytes: 16 * GiB }),
  }),
  node(5, {
    slug: "db-1",
    type: "databases",
    hostname: "db-1",
    displayName: "Database host",
    lastHealthReport: health({ cpuPercent: 12.6 }),
  }),
  node(6, {
    slug: "storage-1",
    type: "storage",
    hostname: "storage-1",
    displayName: "Object storage",
    lastHealthReport: health({ cpuPercent: 4.2 }),
  }),
  node(7, {
    slug: "monitor-1",
    type: "monitoring",
    hostname: "monitor-1",
    displayName: "Monitoring",
    status: "offline",
    isConnected: false,
    lastSeenAt: ago(3, "h"),
    healthHistory: healthHistory("healthy").map((entry, index) =>
      index > 41 ? { ...entry, status: "offline" } : entry
    ),
  }),
];

export const nodeById = (id: string) => nodes.find((item) => item.id === id);
export const nodeBySlug = (slug: string) => nodes.find((item) => item.slug === slug);
export const dockerNodes = nodes.filter((item) => item.type === "docker");
export const edgeNode = nodes[0];
export const appsNode = nodes[2];

function monitoringHistory(): NodeMonitoringSnapshot[] {
  return Array.from({ length: 60 }, (_, index) => {
    const wave = Math.sin(index / 6) * 8;
    return {
      timestamp: ago((60 - index) * 60, "s"),
      health: health({
        cpuPercent: 22 + wave + (index % 7),
        systemMemoryUsedBytes: (3.2 + Math.cos(index / 9) * 0.4) * GiB,
        timestamp: agoMs((60 - index) * 60, "s"),
      }),
      stats: {
        activeConnections: 180 + Math.round(wave * 6),
        accepts: 1_000_000 + index * 1200,
        handled: 1_000_000 + index * 1200,
        requests: 4_000_000 + index * 5200,
        reading: 2,
        writing: 11,
        waiting: 167,
        timestamp: agoMs((60 - index) * 60, "s"),
      },
      traffic: {
        statusCodes: { s2xx: 5_020 + index * 3, s3xx: 210, s4xx: 61, s5xx: index === 38 ? 9 : 1 },
        avgResponseTime: (42 + wave) / 1000,
        p95ResponseTime: (118 + wave * 2) / 1000,
        totalRequests: 5_300 + index * 3,
      },
    };
  });
}

export function nodeDetail(target: Node): NodeDetail {
  const report = target.lastHealthReport ?? health();
  return {
    ...target,
    lastHealthReport: report,
    lastStatsReport: {
      activeConnections: 184,
      accepts: 1_072_000,
      handled: 1_072_000,
      requests: 4_310_000,
      reading: 2,
      writing: 11,
      waiting: 171,
      timestamp: agoMs(20, "s"),
    },
    liveHealthReport: report,
    liveStatsReport: null,
    monitoringHistory: monitoringHistory(),
  };
}
