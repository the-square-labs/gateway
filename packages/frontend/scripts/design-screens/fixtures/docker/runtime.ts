/**
 * What a running container reports at runtime: stats history, processes,
 * environment, secrets, files, plus the side data its Settings and Environment
 * tabs read (networks, managed volumes, webhook, image cleanup, managed links).
 * Uuid seeds: 7070–7099.
 */
import { http } from "msw";
import type { DockerSecret, FileEntry } from "@/types";
import { ok, wrapped } from "../../handlers";
import { managedDatabases } from "../data/databases";
import { managedStorages } from "../data/storage";
import { dockerNodes } from "../nodes";
import { systemConfig } from "../shell";
import { ago, agoMs, uuid } from "../time";
import { apps1, containerRows, fullId, networkRows, snapshotNodeMeta, volumeRows } from "./data";

const MiB = 1024 ** 2;

interface Profile {
  cpu: number;
  memMiB: number;
  limitMiB: number;
  rxPerSample: number;
  txPerSample: number;
  pids: number;
}

const profiles: Record<string, Profile> = {
  web: {
    cpu: 3.2,
    memMiB: 38,
    limitMiB: 512,
    rxPerSample: 420_000,
    txPerSample: 2_900_000,
    pids: 5,
  },
  api: {
    cpu: 11.8,
    memMiB: 212,
    limitMiB: 1024,
    rxPerSample: 900_000,
    txPerSample: 1_300_000,
    pids: 23,
  },
  worker: {
    cpu: 7.4,
    memMiB: 188,
    limitMiB: 512,
    rxPerSample: 120_000,
    txPerSample: 80_000,
    pids: 12,
  },
  "redis-cache": {
    cpu: 1.6,
    memMiB: 64,
    limitMiB: 256,
    rxPerSample: 260_000,
    txPerSample: 310_000,
    pids: 6,
  },
  checkout: {
    cpu: 9.6,
    memMiB: 244,
    limitMiB: 768,
    rxPerSample: 640_000,
    txPerSample: 710_000,
    pids: 9,
  },
};

function profileFor(name: string): Profile {
  const key = Object.keys(profiles).find((candidate) => name.includes(candidate));
  return key ? profiles[key] : profiles.worker;
}

/** 40 samples, one every 15 seconds, with a busy spell in the middle. */
export function statsHistory(name: string) {
  const profile = profileFor(name);
  let rx = 1_840_000_000;
  let tx = 6_120_000_000;
  let read = 210_000_000;
  let write = 480_000_000;
  return Array.from({ length: 40 }, (_, index) => {
    const wave = Math.sin(index / 4) * 0.35 + (index >= 22 && index <= 27 ? 0.9 : 0);
    rx += Math.round(profile.rxPerSample * (1 + wave));
    tx += Math.round(profile.txPerSample * (1 + wave));
    read += 40_000 + (index % 5) * 9_000;
    write += 120_000 + (index % 3) * 30_000;
    return {
      timestamp: agoMs((40 - index) * 15, "s"),
      cpuPercent: Math.max(0.2, profile.cpu * (1 + wave) + (index % 4) * 0.3),
      memoryUsageBytes: Math.round((profile.memMiB + Math.cos(index / 6) * 6 + index * 0.2) * MiB),
      memoryLimitBytes: profile.limitMiB * MiB,
      networkRxBytes: rx,
      networkTxBytes: tx,
      blockReadBytes: read,
      blockWriteBytes: write,
      pids: profile.pids + (index % 6 === 0 ? 1 : 0),
    };
  });
}

const processTable: Record<string, string[][]> = {
  web: [
    ["root", "1", "0", "0", "6d", "?", "00:00:02", "nginx: master process nginx -g daemon off;"],
    ["nginx", "29", "1", "0", "6d", "?", "00:04:11", "nginx: worker process"],
    ["nginx", "30", "1", "0", "6d", "?", "00:04:08", "nginx: worker process"],
    ["nginx", "31", "1", "0", "6d", "?", "00:03:57", "nginx: worker process"],
    ["nginx", "32", "1", "0", "6d", "?", "00:04:02", "nginx: worker process"],
  ],
  checkout: [
    [
      "app",
      "1",
      "0",
      "0",
      "3h",
      "?",
      "00:00:04",
      "/usr/local/bin/python /usr/local/bin/gunicorn checkout.wsgi",
    ],
    [
      "app",
      "7",
      "1",
      "1",
      "3h",
      "?",
      "00:02:31",
      "/usr/local/bin/python /usr/local/bin/gunicorn checkout.wsgi",
    ],
    [
      "app",
      "8",
      "1",
      "1",
      "3h",
      "?",
      "00:02:26",
      "/usr/local/bin/python /usr/local/bin/gunicorn checkout.wsgi",
    ],
    ["app", "9", "1", "0", "3h", "?", "00:00:41", "/usr/local/bin/python -m checkout.outbox"],
  ],
  api: [
    ["node", "1", "0", "2", "2d", "?", "00:21:40", "node dist/server.js"],
    ["node", "19", "1", "0", "2d", "?", "00:00:12", "node dist/metrics.js"],
  ],
  worker: [
    ["node", "1", "0", "1", "2d", "?", "00:11:02", "node dist/worker.js --queues default,mail"],
  ],
  "redis-cache": [["redis", "1", "0", "0", "2d", "?", "00:03:18", "redis-server *:6379"]],
};

export function processesFor(name: string) {
  const key = Object.keys(processTable).find((candidate) => name.includes(candidate)) ?? "worker";
  const rows = processTable[key];
  return {
    Titles: ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"],
    Processes: rows,
    truncated: false,
    totalProcesses: rows.length,
    limit: 200,
  };
}

export const webEnv = [
  "API_URL=http://api:3000",
  "PUBLIC_URL=https://app.example.com",
  "NGINX_VERSION=1.27.2",
  "NJS_VERSION=0.8.5",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
];

export const webSecrets: DockerSecret[] = [
  {
    id: uuid(7070),
    key: "SESSION_SECRET",
    value: "••••••••",
    createdAt: ago(64, "d"),
    updatedAt: ago(30, "d"),
  },
  {
    id: uuid(7071),
    key: "SENTRY_DSN",
    value: "••••••••",
    createdAt: ago(64, "d"),
    updatedAt: ago(64, "d"),
  },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ls -la` time column (`Sep 20 04:18`), which is what the daemons report. */
export function lsTime(days: number) {
  const date = new Date(ago(days, "d"));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const dir = (name: string, days: number, mode = "drwxr-xr-x"): FileEntry => ({
  name,
  size: 4096,
  permissions: mode,
  isDir: true,
  modified: lsTime(days),
});
export const file = (name: string, size: number, days: number, mode = "-rw-r--r--"): FileEntry => ({
  name,
  size,
  permissions: mode,
  isDir: false,
  modified: lsTime(days),
});

/** Root of a Debian-based application image (the `checkout` deployment). */
export const appRootFiles: FileEntry[] = [
  dir("app", 3),
  dir("bin", 44),
  dir("boot", 44),
  dir("dev", 0),
  dir("etc", 3),
  dir("home", 44),
  dir("lib", 44),
  dir("proc", 0, "dr-xr-xr-x"),
  dir("root", 44, "drwx------"),
  dir("run", 0),
  dir("sbin", 44),
  dir("srv", 44),
  dir("sys", 0, "dr-xr-xr-x"),
  dir("tmp", 0, "drwxrwxrwt"),
  dir("usr", 44),
  dir("var", 44),
];

/** Directory listings of the `web` container (nginx on Alpine). */
export const webFiles: Record<string, FileEntry[]> = {
  "/": [
    dir("bin", 40),
    dir("dev", 6),
    dir("docker-entrypoint.d", 40),
    dir("etc", 6),
    dir("home", 40),
    dir("lib", 40),
    dir("media", 40),
    dir("mnt", 40),
    dir("opt", 40),
    dir("proc", 6, "dr-xr-xr-x"),
    dir("root", 40, "drwx------"),
    dir("run", 6),
    dir("sbin", 40),
    dir("srv", 40),
    dir("sys", 6, "dr-xr-xr-x"),
    dir("tmp", 6, "drwxrwxrwt"),
    dir("usr", 40),
    dir("var", 40),
    { ...file("docker-entrypoint.sh", 1620, 40, "-rwxr-xr-x") },
  ],
  "/usr/share/nginx/html": [
    dir("assets", 7),
    dir("uploads", 1),
    file("index.html", 5123, 7),
    file("favicon.ico", 15_086, 40),
    file("manifest.webmanifest", 412, 7),
    file("robots.txt", 68, 40),
  ],
};

/** Files at the root of the `web-uploads` volume. */
export const volumeFiles: Record<string, FileEntry[]> = {
  "/": [
    dir("avatars", 2),
    dir("invoices", 1),
    dir("products", 4),
    dir("tmp", 0),
    file(".keep", 0, 160),
    file("import-2026-q3.csv", 2_418_211, 12),
    file("catalog-export.json", 884_120, 3),
  ],
};

const containerNameById = (containerId: string) => {
  const row = containerRows.find(
    (item) => fullId(item.id) === containerId || item.id === containerId
  );
  return row?.name ?? containerId;
};

/**
 * Runtime endpoints of any container on the Docker nodes, keyed by the id in the path.
 * `names` maps extra runtime ids (deployment slots, Compose services) to a profile name.
 */
export function dockerRuntimeHandlers(names: Record<string, string> = {}) {
  const nameOf = (id: unknown) => names[String(id)] ?? containerNameById(String(id));
  return [
    http.get("*/api/docker/nodes/:nodeId/containers/gpu-usage", () => wrapped([])),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/stats/history", ({ params }) =>
      wrapped(statsHistory(nameOf(params.containerId)))
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/stats", ({ params }) =>
      wrapped(statsHistory(nameOf(params.containerId)).at(-1))
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/top", ({ params }) =>
      wrapped(processesFor(nameOf(params.containerId)))
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/env", ({ params }) =>
      wrapped(nameOf(params.containerId) === "web" ? webEnv : ["NODE_ENV=production"])
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/secrets", ({ params }) =>
      wrapped(nameOf(params.containerId) === "web" ? webSecrets : [])
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/files", ({ params, request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "/";
      if (nameOf(params.containerId) !== "web") return wrapped(appRootFiles);
      return wrapped(webFiles[path] ?? webFiles["/"]);
    }),
    http.get("*/api/docker/nodes/:nodeId/containers/:name/webhook", ({ params }) =>
      wrapped({
        id: uuid(7072),
        nodeId: String(params.nodeId),
        containerName: String(params.name),
        token: "example-webhook-token-0000",
        enabled: true,
        targetType: "container",
        deploymentId: null,
        createdAt: ago(30, "d"),
        updatedAt: ago(30, "d"),
      })
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:name/image-cleanup", ({ params }) =>
      wrapped({
        id: uuid(7073),
        nodeId: String(params.nodeId),
        targetType: "container",
        containerName: String(params.name),
        deploymentId: null,
        enabled: true,
        retentionCount: 3,
        createdAt: ago(30, "d"),
        updatedAt: ago(30, "d"),
      })
    ),
    http.get("*/api/docker/nodes/:nodeId/managed-volumes", ({ params }) =>
      wrapped(
        volumeRows.filter((row) => row.nodeId === params.nodeId).map((row) => ({ name: row.name }))
      )
    ),
    http.get("*/api/docker/nodes/:nodeId/networks", ({ params }) => {
      const data = networkRows.filter((row) => row.nodeId === params.nodeId);
      const node = dockerNodes.find((item) => item.id === params.nodeId) ?? apps1;
      return ok({
        data,
        nodes: [snapshotNodeMeta(node)],
        total: data.length,
        limit: 1000,
        truncated: false,
      });
    }),
    http.get("*/api/docker/nodes/:nodeId/containers", ({ params }) => {
      const data = containerRows.filter((row) => row.nodeId === params.nodeId);
      return ok({ data, total: data.length, limit: 1000, truncated: false });
    }),
    http.get("*/api/system/config", () => wrapped(systemConfig)),
    http.get("*/api/databases/managed", () => wrapped(managedDatabases)),
    http.get("*/api/managed-storage", () => wrapped(managedStorages)),
    // No managed database or storage is linked to these workloads.
    http.get("*/api/databases/managed/:id/bindings", () => wrapped([])),
    http.get("*/api/managed-storage/:id/bindings", () => wrapped([])),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/logs", () => wrapped([])),
    http.get("*/api/docker/availability/by-resource", () => wrapped(null)),
  ];
}
