/**
 * Docker fixtures: the containers, deployments, Compose projects, images, volumes,
 * networks and tasks that run on the two Docker nodes (apps-1, apps-2).
 * Uuid seeds for this group live in 7000–7999.
 */
import type {
  DockerComposeOperation,
  DockerComposeProject,
  DockerComposeProjectSummary,
  DockerComposeRevision,
  DockerContainer,
  DockerFolderTreeNode,
  DockerImage,
  DockerNetwork,
  DockerRegistry,
  DockerTask,
  DockerVolume,
  Node,
} from "@/types";
import { containers as catalogContainers } from "../catalog";
import { dockerNodes } from "../nodes";
import { ago, uuid } from "../time";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const apps1 = dockerNodes.find((node) => node.slug === "apps-1") as Node;
export const apps2 = dockerNodes.find((node) => node.slug === "apps-2") as Node;

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/** A 64-hex Docker id that keeps the catalog's 12-char short id as its prefix. */
export function fullId(short: string, salt = 0): string {
  let hex = short;
  let state = (short.split("").reduce((sum, ch) => sum * 31 + ch.charCodeAt(0), 7) + salt) >>> 0;
  while (hex.length < 64) {
    state = (Math.imul(state ^ (state >>> 13), 1103515245) + 12345) >>> 0;
    hex += state.toString(16).padStart(8, "0");
  }
  return hex.slice(0, 64);
}

const catalog = Object.fromEntries(catalogContainers.map((item) => [item.name, item])) as Record<
  (typeof catalogContainers)[number]["name"],
  (typeof catalogContainers)[number]
>;

// ── Folders ──────────────────────────────────────────────────────────

export const folderIds = {
  app: uuid(7101),
  observability: uuid(7102),
  composeStack: uuid(7103),
  composeAnalytics: uuid(7104),
};

function folder(
  id: string,
  name: string,
  sortOrder: number,
  extra: Partial<DockerFolderTreeNode> = {}
): DockerFolderTreeNode {
  return {
    id,
    name,
    resourceType: "container",
    parentId: null,
    sortOrder,
    depth: 0,
    isSystem: false,
    nodeId: null,
    composeProject: null,
    createdAt: ago(160, "d"),
    updatedAt: ago(12, "d"),
    children: [],
    ...extra,
  };
}

export const containerFolders: DockerFolderTreeNode[] = [
  folder(folderIds.app, "Northwind app", 0),
  folder(folderIds.observability, "Observability", 1),
  // Compose projects own system folders; the containers tab hides them.
  folder(folderIds.composeStack, "northwind-stack", 2, {
    isSystem: true,
    nodeId: apps2.id,
    composeProject: "northwind-stack",
  }),
  folder(folderIds.composeAnalytics, "analytics-pipeline", 3, {
    isSystem: true,
    nodeId: apps1.id,
    composeProject: "analytics-pipeline",
  }),
];

// ── Containers tab (standalone containers + deployments) ─────────────

type ContainerRow = DockerContainer & { nodeId: string };

interface ContainerSeed {
  name: string;
  short: string;
  image: string;
  node: Node;
  state: string;
  status: string;
  createdAgo: [number, "m" | "h" | "d"];
  ports?: DockerContainer["ports"];
  health?: DockerContainer["healthStatus"];
  folderId?: string | null;
  folderSortOrder?: number;
  kind?: "container" | "deployment";
  deploymentId?: string;
  activeSlot?: "blue" | "green";
}

function containerRow(seed: ContainerSeed, index: number): ContainerRow {
  const healthCheckEnabled = !!seed.health && seed.health !== "disabled";
  return {
    id: seed.kind === "deployment" ? (seed.deploymentId as string) : fullId(seed.short),
    scopeResourceId: uuid(7200 + index),
    name: seed.name,
    image: seed.image,
    state: seed.state,
    status: seed.status,
    created: unix(ago(seed.createdAgo[0], seed.createdAgo[1])),
    ports: seed.ports ?? [],
    portsCount: seed.ports?.length ?? 0,
    portsTruncated: false,
    kind: seed.kind ?? "container",
    deploymentId: seed.deploymentId,
    activeSlot: seed.activeSlot,
    primaryRoute:
      seed.kind === "deployment" && seed.ports?.[0]?.publicPort
        ? { hostPort: seed.ports[0].publicPort, containerPort: seed.ports[0].privatePort }
        : null,
    activeSlotContainerId: seed.kind === "deployment" ? fullId(seed.short) : null,
    healthCheckId: healthCheckEnabled ? uuid(7300 + index) : null,
    healthCheckEnabled,
    healthStatus: seed.state === "exited" ? "stopped" : (seed.health ?? "disabled"),
    secureLinkDown: false,
    lastHealthCheckAt: healthCheckEnabled ? ago(25, "s") : null,
    folderId: seed.folderId ?? null,
    folderIsSystem: false,
    folderSortOrder: seed.folderSortOrder ?? 0,
    nodeId: seed.node.id,
    availability: "available",
  };
}

export const checkoutDeploymentId = uuid(7010);

const containerSeeds: ContainerSeed[] = [
  {
    name: "web",
    short: catalog.web.id,
    image: catalog.web.image,
    node: apps1,
    state: "running",
    status: "Up 6 days (healthy)",
    createdAgo: [6, "d"],
    ports: [{ privatePort: 80, publicPort: 8080, type: "tcp", ip: "0.0.0.0" }],
    health: "online",
    folderId: folderIds.app,
    folderSortOrder: 0,
  },
  {
    name: "api",
    short: catalog.api.id,
    image: catalog.api.image,
    node: apps1,
    state: "running",
    status: "Up 6 days (healthy)",
    createdAgo: [6, "d"],
    ports: [{ privatePort: 3000, publicPort: 8081, type: "tcp", ip: "0.0.0.0" }],
    health: "online",
    folderId: folderIds.app,
    folderSortOrder: 1,
  },
  {
    name: "worker",
    short: catalog.worker.id,
    image: catalog.worker.image,
    node: apps1,
    state: "running",
    status: "Up 6 days",
    createdAgo: [6, "d"],
    folderId: folderIds.app,
    folderSortOrder: 2,
  },
  {
    name: "checkout",
    short: "c0ffee0ba1b2",
    image: "registry.example.com/northwind/checkout:1.14.0",
    node: apps1,
    state: "running",
    status: "running",
    createdAgo: [41, "d"],
    ports: [{ privatePort: 8000, publicPort: 8090, type: "tcp", ip: "0.0.0.0" }],
    health: "online",
    folderId: folderIds.app,
    folderSortOrder: 3,
    kind: "deployment",
    deploymentId: checkoutDeploymentId,
    activeSlot: "green",
  },
  {
    name: "redis-cache",
    short: catalog["redis-cache"].id,
    image: catalog["redis-cache"].image,
    node: apps1,
    state: "running",
    status: "Up 3 weeks",
    createdAgo: [23, "d"],
    ports: [{ privatePort: 6379, type: "tcp" }],
  },
  {
    name: "postgres-sidecar",
    short: "c0ffee06a1b2",
    image: "postgres:16.4-alpine",
    node: apps1,
    state: "running",
    status: "Up 12 days (healthy)",
    createdAgo: [12, "d"],
    ports: [{ privatePort: 5432, type: "tcp" }],
    health: "online",
  },
  {
    name: "grafana",
    short: catalog.grafana.id,
    image: catalog.grafana.image,
    node: apps2,
    state: "running",
    status: "Up 9 days (healthy)",
    createdAgo: [9, "d"],
    ports: [{ privatePort: 3000, publicPort: 3000, type: "tcp", ip: "0.0.0.0" }],
    health: "degraded",
    folderId: folderIds.observability,
    folderSortOrder: 0,
  },
  {
    name: "node-exporter",
    short: "c0ffee07a1b2",
    image: "prom/node-exporter:v1.8.2",
    node: apps2,
    state: "running",
    status: "Up 5 weeks",
    createdAgo: [36, "d"],
    ports: [{ privatePort: 9100, publicPort: 9100, type: "tcp", ip: "0.0.0.0" }],
    folderId: folderIds.observability,
    folderSortOrder: 1,
  },
  {
    name: "image-resizer",
    short: "c0ffee08a1b2",
    image: "registry.example.com/northwind/image-resizer:0.9.3",
    node: apps2,
    state: "restarting",
    status: "Restarting (137) 14 seconds ago",
    createdAgo: [2, "h"],
    ports: [{ privatePort: 8080, publicPort: 8085, type: "tcp", ip: "0.0.0.0" }],
    health: "offline",
  },
  {
    name: "mailer",
    short: "c0ffee09a1b2",
    image: "registry.example.com/northwind/mailer:1.3.0",
    node: apps2,
    state: "exited",
    status: "Exited (0) 2 days ago",
    createdAgo: [18, "d"],
  },
];

export const containerRows: ContainerRow[] = containerSeeds.map(containerRow);

export const containerByName = (nodeId: string, name: string) =>
  containerRows.find((row) => row.nodeId === nodeId && row.name === name);

// ── Snapshot envelopes ───────────────────────────────────────────────

export function snapshotNodeMeta(node: Node) {
  return {
    id: node.id,
    slug: node.slug,
    hostname: node.hostname,
    displayName: node.displayName,
    appearanceColor: node.appearanceColor,
    availability: "available",
    revision: 318,
    observedAt: ago(8, "s"),
    lastAttemptAt: ago(8, "s"),
    lastError: null,
  };
}

export function snapshotEnvelope<T extends { nodeId?: string }>(
  rows: T[],
  params: URLSearchParams,
  matches: (row: T, query: string) => boolean
) {
  const nodeId = params.get("nodeId");
  const search = params.get("search")?.trim().toLowerCase() ?? "";
  const nodes = nodeId ? dockerNodes.filter((node) => node.id === nodeId) : dockerNodes;
  const data = rows.filter(
    (row) => (!nodeId || row.nodeId === nodeId) && (!search || matches(row, search))
  );
  return {
    data,
    nodes: nodes.map(snapshotNodeMeta),
    total: data.length,
    limit: 1000,
    truncated: false,
  };
}

// ── Images ───────────────────────────────────────────────────────────

type ImageRow = DockerImage & { nodeId: string };

function image(
  node: Node,
  index: number,
  tags: string[],
  sizeMiB: number,
  createdDays: number,
  containers: number
): ImageRow {
  const id = `sha256:${fullId(`${index.toString(16).padStart(4, "0")}ab12cd34`, index)}`;
  return {
    id,
    scopeResourceId: id,
    repoTags: tags,
    repoTagsCount: tags.length,
    repoTagsTruncated: false,
    repoDigests: tags.length
      ? [`${tags[0].split(":")[0]}@sha256:${fullId("d1e5", index + 40)}`]
      : [],
    size: Math.round(sizeMiB * MiB),
    created: unix(ago(createdDays, "d")),
    containers,
    folderId: null,
    folderIsSystem: false,
    folderSortOrder: 0,
    nodeId: node.id,
    availability: "available",
  };
}

export const imageRows: ImageRow[] = [
  image(apps1, 1, [catalog.web.image], 182.4, 7, 1),
  image(apps1, 2, [catalog.api.image], 241.7, 7, 1),
  image(apps1, 3, [catalog.worker.image], 238.1, 7, 1),
  image(apps1, 4, ["registry.example.com/northwind/checkout:1.14.0"], 156.3, 3, 1),
  image(apps1, 5, ["registry.example.com/northwind/checkout:1.13.2"], 155.9, 19, 0),
  image(apps1, 6, [catalog["redis-cache"].image], 41.2, 30, 1),
  image(apps1, 7, ["postgres:16.4-alpine"], 247.6, 44, 1),
  image(apps1, 8, ["registry.example.com/northwind/web:2.8.0"], 181.9, 21, 0),
  image(apps2, 9, [catalog.grafana.image], 463.5, 40, 1),
  image(apps2, 10, ["prom/node-exporter:v1.8.2"], 22.8, 90, 1),
  image(apps2, 11, ["registry.example.com/northwind/image-resizer:0.9.3"], 312.4, 1, 1),
  image(apps2, 12, ["registry.example.com/northwind/mailer:1.3.0"], 96.1, 25, 1),
  image(apps2, 13, ["registry.example.com/northwind/web:2.9.0-rc.2"], 183.2, 2, 1),
  image(apps2, 14, ["registry.example.com/northwind/api:2.9.0-rc.2"], 243.0, 2, 1),
  image(apps2, 15, ["registry.example.com/northwind/worker:2.9.0-rc.2"], 239.4, 2, 1),
  image(apps2, 16, ["redis:7.4-alpine"], 41.2, 30, 1),
  image(apps2, 17, [], 118.7, 33, 0),
];

// ── Volumes ──────────────────────────────────────────────────────────

type VolumeRow = DockerVolume & { nodeId: string };

function volume(
  node: Node,
  name: string,
  usedBy: string[],
  usedGiB: number,
  createdDays: number,
  extra: Partial<DockerVolume> = {}
): VolumeRow {
  return {
    name,
    scopeResourceId: name,
    driver: "local",
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    scope: "local",
    managementState: "managed",
    storageKind: "regular",
    capacityBytes: null,
    usedBytes: Math.round(usedGiB * GiB),
    adoptable: false,
    createdAt: ago(createdDays, "d"),
    usedBy,
    usedByCount: usedBy.length,
    usedByTruncated: false,
    folderId: null,
    folderIsSystem: false,
    folderSortOrder: 0,
    nodeId: node.id,
    availability: "available",
    ...extra,
  };
}

export const volumeRows: VolumeRow[] = [
  volume(apps1, "web-uploads", ["web"], 3.8, 160),
  volume(apps1, "redis-cache-data", ["redis-cache"], 0.42, 120),
  volume(apps1, "postgres-sidecar-data", ["postgres-sidecar"], 6.1, 44, {
    storageKind: "disk-image",
    capacityBytes: 20 * GiB,
  }),
  volume(apps1, "worker-scratch", ["worker"], 0.9, 60),
  volume(apps2, "grafana-data", ["grafana"], 1.3, 140),
  volume(apps2, "mailer-queue", [], 0.05, 90, { managementState: "legacy", adoptable: true }),
];

// ── Networks ─────────────────────────────────────────────────────────

type NetworkRow = DockerNetwork & { nodeId: string };

function network(
  node: Node,
  seed: number,
  name: string,
  subnet: string,
  members: string[]
): NetworkRow {
  const id = fullId(`${seed.toString(16)}e7a0b1c2d3`, seed);
  return {
    id,
    scopeResourceId: uuid(7400 + seed),
    name,
    driver: "bridge",
    scope: "local",
    ipam: {
      subnet,
      gateway: subnet.replace(/0\/\d+$/, "1"),
      config: [{ subnet, gateway: subnet.replace(/0\/\d+$/, "1") }],
    },
    containers: Object.fromEntries(
      members.map((member, index) => [fullId(member, index), { name: member }])
    ),
    containersCount: members.length,
    containersTruncated: false,
    folderId: null,
    folderIsSystem: false,
    folderSortOrder: 0,
    nodeId: node.id,
    availability: "available",
  };
}

export const networkRows: NetworkRow[] = [
  network(apps1, 1, "northwind-internal", "172.20.0.0/16", ["web", "api", "worker", "redis-cache"]),
  network(apps1, 2, "northwind-db", "172.21.0.0/16", ["api", "worker", "postgres-sidecar"]),
  network(apps2, 3, "observability", "172.22.0.0/16", ["grafana", "node-exporter"]),
  network(apps2, 4, "media", "172.23.0.0/16", ["image-resizer", "mailer"]),
];

// ── Tasks ────────────────────────────────────────────────────────────

export const tasks: DockerTask[] = [
  {
    id: uuid(7501),
    nodeId: apps2.id,
    containerName: "image-resizer",
    type: "recreate",
    status: "failed",
    error: "Container exited with code 137 (out of memory) during health check",
    createdAt: ago(14, "m"),
    completedAt: ago(13, "m"),
  },
  {
    id: uuid(7502),
    nodeId: apps1.id,
    containerName: "checkout",
    type: "deploy",
    status: "succeeded",
    progress: "Switched traffic to green",
    createdAt: ago(182, "m"),
    completedAt: ago(180, "m"),
  },
  {
    id: uuid(7503),
    nodeId: apps1.id,
    type: "pull",
    status: "succeeded",
    progress: "registry.example.com/northwind/checkout:1.14.0",
    createdAt: ago(184, "m"),
    completedAt: ago(183, "m"),
  },
  {
    id: uuid(7506),
    nodeId: apps1.id,
    containerName: "web",
    type: "restart",
    status: "succeeded",
    createdAt: ago(20 * 3600, "s"),
    completedAt: ago(20 * 3600 - 11, "s"),
  },
  {
    id: uuid(7507),
    nodeId: apps1.id,
    containerName: "web",
    type: "pull",
    status: "succeeded",
    progress: "registry.example.com/northwind/web:2.8.1",
    createdAt: ago(6 * 1440 + 3, "m"),
    completedAt: ago(6 * 1440 + 2, "m"),
  },
  {
    id: uuid(7504),
    nodeId: apps1.id,
    containerName: "web",
    type: "update",
    status: "succeeded",
    createdAt: ago(6 * 1440 + 1, "m"),
    completedAt: ago(6 * 1440, "m"),
  },
  {
    id: uuid(7505),
    nodeId: apps2.id,
    containerName: "mailer",
    type: "stop",
    status: "succeeded",
    createdAt: ago(2 * 86400, "s"),
    completedAt: ago(2 * 86400 - 9, "s"),
  },
];

// ── Registries ───────────────────────────────────────────────────────

export const registries: DockerRegistry[] = [
  {
    id: uuid(7601),
    name: "Northwind registry",
    url: "https://registry.example.com",
    username: "deploy-bot",
    source: "manual",
    scope: "global",
    createdAt: ago(200, "d"),
    updatedAt: ago(30, "d"),
  },
  {
    id: uuid(7602),
    name: "GitHub Container Registry",
    url: "https://ghcr.example.net",
    username: "northwind-ci",
    source: "manual",
    scope: "global",
    createdAt: ago(120, "d"),
    updatedAt: ago(120, "d"),
  },
];

// ── Compose ──────────────────────────────────────────────────────────

export const composeIds = {
  stack: uuid(7701),
  analytics: uuid(7702),
  stackRevision: uuid(7711),
  stackPrevRevision: uuid(7712),
  analyticsRevision: uuid(7713),
};

export const stackServices = [
  {
    name: "web",
    image: "registry.example.com/northwind/web:2.9.0-rc.2",
    state: "running",
    health: "healthy",
    short: "5eed01a1b2c3",
  },
  {
    name: "api",
    image: "registry.example.com/northwind/api:2.9.0-rc.2",
    state: "running",
    health: "healthy",
    short: "5eed02a1b2c3",
  },
  {
    name: "worker",
    image: "registry.example.com/northwind/worker:2.9.0-rc.2",
    state: "running",
    health: "none",
    short: "5eed03a1b2c3",
  },
  {
    name: "redis-cache",
    image: "redis:7.4-alpine",
    state: "running",
    health: "healthy",
    short: "5eed04a1b2c3",
  },
] as const;

export const stackYaml = `name: northwind-stack

services:
  web:
    image: registry.example.com/northwind/web:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "8180:80"
    environment:
      API_URL: http://api:3000
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/healthz"]
      interval: 15s

  api:
    image: registry.example.com/northwind/api:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "8181:3000"
    environment:
      DATABASE_URL: \${DATABASE_URL}
      REDIS_URL: redis://redis-cache:6379/0
    depends_on:
      redis-cache:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 15s

  worker:
    image: registry.example.com/northwind/worker:\${APP_VERSION}
    restart: unless-stopped
    command: ["node", "dist/worker.js", "--queues", "default,mail"]
    environment:
      REDIS_URL: redis://redis-cache:6379/0
    deploy:
      resources:
        limits:
          memory: 512M

  redis-cache:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s

volumes:
  redis-data:

networks:
  default:
    name: northwind-stack_default
`;

function revision(
  id: string,
  projectId: string,
  revisionNumber: number,
  createdAt: string,
  yaml: string,
  services: DockerComposeRevision["normalizedModel"]["services"],
  variables: Record<string, string>
): DockerComposeRevision {
  return {
    id,
    projectId,
    revisionNumber,
    sourceYaml: yaml,
    originalYaml: yaml,
    normalizedModel: {
      name: projectId === composeIds.stack ? "northwind-stack" : "analytics-pipeline",
      services,
      volumes: { "redis-data": { driver: "local" } },
      networks: { default: { externalName: "northwind-stack_default" } },
    },
    configDigest: `sha256:${fullId("c0de", revisionNumber)}`,
    variables,
    secretKeys: ["DATABASE_URL"],
    createdById: "user-omar",
    createdAt,
  };
}

const stackNormalizedServices: DockerComposeRevision["normalizedModel"]["services"] = {
  web: {
    image: "registry.example.com/northwind/web:2.9.0-rc.2",
    restart: "unless-stopped",
    ports: [{ target: 80, published: 8180, protocol: "tcp" }],
    environment: { API_URL: "http://api:3000" },
    dependsOn: { api: { condition: "service_healthy" } },
    networks: ["default"],
  },
  api: {
    image: "registry.example.com/northwind/api:2.9.0-rc.2",
    restart: "unless-stopped",
    ports: [{ target: 3000, published: 8181, protocol: "tcp" }],
    environment: { DATABASE_URL: "${DATABASE_URL}", REDIS_URL: "redis://redis-cache:6379/0" },
    dependsOn: { "redis-cache": { condition: "service_healthy" } },
    networks: ["default"],
  },
  worker: {
    image: "registry.example.com/northwind/worker:2.9.0-rc.2",
    restart: "unless-stopped",
    memoryLimit: "512M",
    command: ["node", "dist/worker.js", "--queues", "default,mail"],
    environment: { REDIS_URL: "redis://redis-cache:6379/0" },
    networks: ["default"],
  },
  "redis-cache": {
    image: "redis:7.4-alpine",
    restart: "unless-stopped",
    command: ["redis-server", "--appendonly", "yes"],
    volumes: [{ source: "redis-data", target: "/data" }],
    networks: ["default"],
  },
};

export const stackRevisions: DockerComposeRevision[] = [
  revision(
    composeIds.stackRevision,
    composeIds.stack,
    7,
    ago(2, "d"),
    stackYaml,
    stackNormalizedServices,
    { APP_VERSION: "2.9.0-rc.2", LOG_LEVEL: "info" }
  ),
  revision(
    composeIds.stackPrevRevision,
    composeIds.stack,
    6,
    ago(9, "d"),
    stackYaml,
    stackNormalizedServices,
    { APP_VERSION: "2.9.0-rc.1", LOG_LEVEL: "debug" }
  ),
];

function operation(
  seed: number,
  projectId: string,
  action: DockerComposeOperation["action"],
  status: DockerComposeOperation["status"],
  createdAt: string,
  durationSeconds: number,
  extra: Partial<DockerComposeOperation> = {}
): DockerComposeOperation {
  const completed = new Date(new Date(createdAt).getTime() + durationSeconds * 1000).toISOString();
  return {
    id: uuid(seed),
    projectId,
    revisionId: composeIds.stackRevision,
    taskId: uuid(seed + 50),
    idempotencyKey: uuid(seed + 100),
    action,
    status,
    progress: null,
    error: null,
    options: {},
    createdById: "user-omar",
    createdAt,
    startedAt: createdAt,
    completedAt: status === "running" ? null : completed,
    ...extra,
  };
}

export const stackOperations: DockerComposeOperation[] = [
  operation(7801, composeIds.stack, "pull_apply", "succeeded", ago(2, "d"), 74, {
    progress: "4 services up to date",
  }),
  operation(7802, composeIds.stack, "restart", "succeeded", ago(4, "d"), 12, {
    createdById: "user-maya",
  }),
  // Revision 6 went out on the second try, after the api health check timed out.
  operation(7804, composeIds.stack, "apply", "succeeded", ago(9, "d"), 58, {
    revisionId: composeIds.stackPrevRevision,
  }),
  operation(7803, composeIds.stack, "apply", "failed", ago(9 * 24 + 1, "h"), 41, {
    revisionId: composeIds.stackPrevRevision,
    error: "service api: health check did not pass within 60s",
  }),
  operation(7805, composeIds.stack, "start", "succeeded", ago(15, "d"), 17, {
    createdById: "user-lena",
  }),
  operation(7806, composeIds.stack, "stop", "succeeded", ago(16, "d"), 9, {
    createdById: "user-lena",
  }),
  operation(7807, composeIds.stack, "pull_apply", "succeeded", ago(23, "d"), 96, {
    revisionId: composeIds.stackPrevRevision,
    progress: "4 services updated",
  }),
];

export const composeSummaries: DockerComposeProjectSummary[] = [
  {
    id: composeIds.stack,
    scopeResourceId: composeIds.stack,
    nodeId: apps2.id,
    name: "northwind-stack",
    managementState: "managed",
    desiredState: "running",
    status: "running",
    availability: "available",
    activeRevisionId: composeIds.stackRevision,
    observedFingerprint: fullId("f1a9", 1).slice(0, 16),
    lastSeenAt: ago(9, "s"),
    serviceCount: 4,
    runningServiceCount: 4,
    healthyServiceCount: 3,
    drifted: false,
    lastOperation: stackOperations[0],
    folderId: null,
    folderSortOrder: 0,
    createdAt: ago(64, "d"),
    updatedAt: ago(2, "d"),
  },
  {
    id: composeIds.analytics,
    scopeResourceId: composeIds.analytics,
    nodeId: apps1.id,
    name: "analytics-pipeline",
    managementState: "managed",
    desiredState: "running",
    status: "degraded",
    availability: "available",
    activeRevisionId: composeIds.analyticsRevision,
    observedFingerprint: fullId("f1a9", 2).slice(0, 16),
    lastSeenAt: ago(9, "s"),
    serviceCount: 3,
    runningServiceCount: 2,
    healthyServiceCount: 2,
    drifted: true,
    lastOperation: null,
    folderId: null,
    folderSortOrder: 1,
    createdAt: ago(120, "d"),
    updatedAt: ago(6, "h"),
  },
];

export const stackProject: DockerComposeProject = {
  ...composeSummaries[0],
  activeRevision: stackRevisions[0],
  revisions: stackRevisions,
  operations: stackOperations,
  services: stackServices.map((service) => ({
    name: service.name,
    image: service.image,
    state: service.state,
    health: service.health,
    containerIds: [fullId(service.short)],
  })),
  volumeNames: ["northwind-stack_redis-data"],
  networkNames: ["northwind-stack_default"],
};

/** Runtime container names of the Compose project's services. */
export const stackContainerName = (service: string) => `northwind-stack-${service}-1`;
