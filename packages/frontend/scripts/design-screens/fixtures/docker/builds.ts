/**
 * Git sources, builds and migrations of the Docker area: the `web` container and the
 * `checkout` deployment on apps-1 are built from Git; the Compose project is YAML-based.
 * Uuid seeds: 7020–7069.
 */
import { HttpResponse, http } from "msw";
import type {
  DockerBuild,
  DockerBuildArtifact,
  DockerBuildLogChunk,
  DockerBuildSecret,
  DockerMigration,
  DockerSourceBinding,
  DockerSourceConnector,
  DockerSourceTarget,
} from "@/types";
import { ok, wrapped } from "../../handlers";
import { pageProjects } from "../catalog";
import { buildWorker } from "../nodes/builder";
import { ago, uuid } from "../time";
import { apps1, apps2, checkoutDeploymentId, fullId } from "./data";

export const sourceConnectors: DockerSourceConnector[] = [
  { id: uuid(7020), name: "Northwind GitLab", provider: "gitlab" },
  { id: uuid(7021), name: "Northwind GitHub", provider: "github" },
];

const sha = (seed: string) => fullId(seed).slice(0, 40);

export const webCommits = {
  deployed: sha("9f3c2a71"),
  previous: sha("51be08d4"),
  rejected: sha("e27d4410"),
  older: sha("0c6a9b35"),
};

export const checkoutCommits = {
  building: sha("7ad1e0c9"),
  deployed: sha("3b94f2e6"),
  previous: sha("c8e15a02"),
};

function binding(
  seed: number,
  target: DockerSourceTarget,
  extra: Partial<DockerSourceBinding> & Pick<DockerSourceBinding, "repositoryFullPath">
): DockerSourceBinding {
  const provider = extra.provider ?? "gitlab";
  const host = provider === "github" ? "github.example.net" : "git.example.com";
  return {
    id: uuid(seed),
    target,
    connectorId: provider === "github" ? sourceConnectors[1].id : sourceConnectors[0].id,
    projectId: uuid(seed + 1),
    provider,
    repositoryRemoteId: String(400 + seed - 7020),
    repositoryCloneUrl: `https://${host}/${extra.repositoryFullPath}.git`,
    branch: "main",
    dockerfilePath: "Dockerfile",
    contextPath: ".",
    composeFilePath: null,
    composeVariables: {},
    composeSecretKeys: [],
    autoBuild: true,
    autoDeploy: true,
    buildArgs: {},
    buildSecretNames: [],
    policy: { vulnerabilityThreshold: "high", vulnerabilityScope: "application" },
    desiredCommitSha: null,
    deployedCommitSha: null,
    lastResolvedAt: ago(4, "m"),
    lastPollAt: ago(4, "m"),
    lastPollError: null,
    webhookConfiguredAt: ago(64, "d"),
    lastWebhookAt: ago(20, "h"),
    lastWebhookError: null,
    createdAt: ago(64, "d"),
    updatedAt: ago(20, "h"),
    ...extra,
  };
}

export const webSource = binding(
  7024,
  { kind: "container", nodeId: apps1.id, containerName: "web" },
  {
    repositoryFullPath: "northwind/web",
    buildArgs: { NODE_ENV: "production", PUBLIC_URL: "https://app.example.com" },
    buildSecretNames: ["NPM_TOKEN"],
    desiredCommitSha: webCommits.deployed,
    deployedCommitSha: webCommits.deployed,
  }
);

export const checkoutSource = binding(
  7026,
  { kind: "deployment", nodeId: apps1.id, deploymentId: checkoutDeploymentId },
  {
    provider: "github",
    repositoryFullPath: "northwind/checkout",
    dockerfilePath: "deploy/Dockerfile",
    branch: "release",
    buildArgs: { PYTHON_VERSION: "3.12" },
    buildSecretNames: ["PIP_INDEX_TOKEN", "SENTRY_AUTH_TOKEN"],
    desiredCommitSha: checkoutCommits.building,
    deployedCommitSha: checkoutCommits.deployed,
    lastWebhookAt: ago(6, "m"),
  }
);

const marketingSourceId = uuid(7028);

function artifact(
  seed: number,
  buildId: string,
  repository: string,
  sizeMiB: number,
  scan: { critical: number; high: number; medium: number; low: number },
  decision: DockerBuildArtifact["policyDecision"] = "approved",
  reason: string | null = null
): DockerBuildArtifact {
  return {
    id: uuid(seed),
    buildId,
    registryRepository: repository,
    digest: `sha256:${fullId(`a7f${seed}`, seed)}`,
    platform: "linux/amd64",
    sizeBytes: Math.round(sizeMiB * 1024 ** 2),
    status: decision === "rejected" ? "rejected" : "ready",
    sbomDigest: `sha256:${fullId(`5b0${seed}`, seed)}`,
    provenanceDigest: `sha256:${fullId(`9e0${seed}`, seed)}`,
    scanSummary: { scanner: "grype", ...scan, unknown: 0, policyScope: "application" },
    policyDecision: decision,
    policyReason: reason,
    verifiedAt: decision === "rejected" ? null : ago(1, "h"),
    createdAt: ago(1, "h"),
  };
}

interface BuildSeed {
  seed: number;
  source:
    | DockerSourceBinding
    | { id: string; provider: DockerBuild["provider"]; repositoryFullPath: string };
  target: DockerBuild["target"];
  commitSha: string;
  status: DockerBuild["status"];
  trigger: DockerBuild["trigger"];
  queuedAgo: [number, "m" | "h" | "d"];
  seconds: number;
  ref?: string;
  artifact?: DockerBuildArtifact | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  progress?: Record<string, unknown>;
}

function build(seed: BuildSeed): DockerBuild {
  const queuedAt = ago(seed.queuedAgo[0], seed.queuedAgo[1]);
  const startedAt = new Date(new Date(queuedAt).getTime() + 4_000).toISOString();
  const active = [
    "queued",
    "claimed",
    "checking_out",
    "building",
    "scanning",
    "pushing",
    "deploying",
  ].includes(seed.status);
  return {
    id: uuid(seed.seed),
    sourceBindingId: seed.source.id,
    batchId: null,
    serviceName: null,
    provider: seed.source.provider,
    trigger: seed.trigger,
    repositoryFullPath: seed.source.repositoryFullPath,
    ref: seed.ref ?? "refs/heads/main",
    commitSha: seed.commitSha,
    status: seed.status,
    builderNodeId: buildWorker.id,
    builderName: buildWorker.displayName,
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: seed.errorCode ?? null,
    errorMessage: seed.errorMessage ?? null,
    progress: seed.progress ?? {},
    artifact: seed.artifact ?? null,
    target: seed.target,
    createdAt: queuedAt,
    queuedAt,
    startedAt,
    completedAt: active
      ? null
      : new Date(new Date(startedAt).getTime() + seed.seconds * 1000).toISOString(),
  };
}

const webTarget = {
  kind: "container",
  nodeId: apps1.id,
  containerName: "web",
  name: "web",
} as const;
const checkoutTarget = {
  kind: "deployment",
  nodeId: apps1.id,
  deploymentId: checkoutDeploymentId,
  name: "checkout",
} as const;

export const webBuilds: DockerBuild[] = [
  build({
    seed: 7030,
    source: webSource,
    target: webTarget,
    commitSha: webCommits.deployed,
    status: "succeeded",
    trigger: "gitlab_push",
    queuedAgo: [20, "h"],
    seconds: 164,
    artifact: artifact(7031, uuid(7030), "internal/northwind/web", 182.4, {
      critical: 0,
      high: 0,
      medium: 3,
      low: 11,
    }),
  }),
  build({
    seed: 7032,
    source: webSource,
    target: webTarget,
    commitSha: webCommits.rejected,
    status: "failed",
    trigger: "gitlab_push",
    queuedAgo: [2, "d"],
    seconds: 151,
    errorCode: "artifact_policy_rejected",
    errorMessage: "2 high vulnerabilities in application packages exceed the policy threshold",
    artifact: artifact(
      7033,
      uuid(7032),
      "internal/northwind/web",
      183.1,
      { critical: 0, high: 2, medium: 4, low: 11 },
      "rejected",
      "2 high vulnerabilities (threshold: high)"
    ),
  }),
  build({
    seed: 7034,
    source: webSource,
    target: webTarget,
    commitSha: webCommits.previous,
    status: "succeeded",
    trigger: "manual",
    queuedAgo: [6, "d"],
    seconds: 178,
    artifact: artifact(7035, uuid(7034), "internal/northwind/web", 181.9, {
      critical: 0,
      high: 0,
      medium: 3,
      low: 12,
    }),
  }),
  build({
    seed: 7036,
    source: webSource,
    target: webTarget,
    commitSha: webCommits.older,
    status: "superseded",
    trigger: "gitlab_push",
    queuedAgo: [9, "d"],
    seconds: 40,
  }),
];

export const checkoutBuilds: DockerBuild[] = [
  build({
    seed: 7040,
    source: checkoutSource,
    target: checkoutTarget,
    ref: "refs/heads/release",
    commitSha: checkoutCommits.building,
    status: "building",
    trigger: "github_push",
    queuedAgo: [3, "m"],
    seconds: 0,
    progress: { step: "RUN pip install -r requirements.txt", stepIndex: 6, stepCount: 11 },
  }),
  build({
    seed: 7042,
    source: checkoutSource,
    target: checkoutTarget,
    ref: "refs/heads/release",
    commitSha: checkoutCommits.deployed,
    status: "succeeded",
    trigger: "github_push",
    queuedAgo: [3, "h"],
    seconds: 212,
    artifact: artifact(7043, uuid(7042), "internal/northwind/checkout", 156.3, {
      critical: 0,
      high: 0,
      medium: 1,
      low: 6,
    }),
  }),
  build({
    seed: 7044,
    source: checkoutSource,
    target: checkoutTarget,
    ref: "refs/heads/release",
    commitSha: checkoutCommits.previous,
    status: "succeeded",
    trigger: "github_push",
    queuedAgo: [19, "d"],
    seconds: 198,
    artifact: artifact(7045, uuid(7044), "internal/northwind/checkout", 155.9, {
      critical: 0,
      high: 0,
      medium: 2,
      low: 6,
    }),
  }),
];

const marketingBuild = build({
  seed: 7046,
  source: {
    id: marketingSourceId,
    provider: "gitlab",
    repositoryFullPath: "northwind/marketing-site",
  },
  target: { kind: "pages_project", pageProjectId: pageProjects[0].id, name: pageProjects[0].name },
  commitSha: sha("4d7e21b8"),
  status: "succeeded",
  trigger: "gitlab_push",
  queuedAgo: [5, "h"],
  seconds: 72,
  artifact: artifact(7047, uuid(7046), "internal/pages/marketing-site", 12.6, {
    critical: 0,
    high: 0,
    medium: 0,
    low: 2,
  }),
});

/** Every build, newest first, as the Builds tab lists them. */
export const allBuilds: DockerBuild[] = [...webBuilds, ...checkoutBuilds, marketingBuild].sort(
  (a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime()
);

export const buildSecrets: Record<string, DockerBuildSecret[]> = {
  [webSource.id]: [
    { id: uuid(7050), name: "NPM_TOKEN", createdAt: ago(64, "d"), updatedAt: ago(30, "d") },
  ],
  [checkoutSource.id]: [
    { id: uuid(7051), name: "PIP_INDEX_TOKEN", createdAt: ago(41, "d"), updatedAt: ago(41, "d") },
    { id: uuid(7052), name: "SENTRY_AUTH_TOKEN", createdAt: ago(41, "d"), updatedAt: ago(12, "d") },
  ],
};

export const buildLog: DockerBuildLogChunk[] = [
  "#1 [internal] load build definition from Dockerfile",
  "#2 [internal] load metadata for docker.io/library/node:22-alpine",
  "#5 [build 2/6] COPY package.json pnpm-lock.yaml ./",
  "#6 [build 3/6] RUN pnpm install --frozen-lockfile",
  "#6 12.41 Done in 12.1s",
  "#8 [build 5/6] RUN pnpm build",
  "#8 38.02 ✓ built in 36.84s",
  "#11 exporting to image",
  "#11 pushing layers 100%",
  "Scan: 0 critical, 0 high, 3 medium, 11 low (grype)",
].map((content, sequence) => ({
  buildId: uuid(7030),
  sequence,
  content: `${content}\n`,
  byteLength: content.length + 1,
  createdAt: ago(20, "h"),
}));

export const migrations: DockerMigration[] = [
  {
    id: uuid(7060),
    sourceNodeId: apps1.id,
    targetNodeId: apps2.id,
    targetNodeSlug: apps2.slug,
    targetResourceId: null,
    resourceType: "container",
    resourceName: "grafana",
    containerName: "grafana",
    deploymentId: null,
    keepSource: false,
    sourceState: "running",
    status: "completed",
    phase: "completed",
    progress: { message: "Moved to Apps 2 with 1 volume (1.3 GB)" },
    createdAt: ago(9 * 24 * 60, "m"),
    startedAt: ago(9 * 24 * 60, "m"),
    updatedAt: ago(9 * 24 * 60 - 6, "m"),
    completedAt: ago(9 * 24 * 60 - 6, "m"),
  },
];

const sourceFor = (params: Record<string, unknown>, kind: "container" | "deployment") => {
  if (params.nodeId !== apps1.id) return null;
  if (kind === "container") return params.name === "web" ? webSource : null;
  return params.deploymentId === checkoutDeploymentId ? checkoutSource : null;
};

/** Build lists, Git sources and migrations. Pass before the list/detail handlers. */
export function dockerBuildHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  return [
    http.get("*/api/docker/builds", ({ request }) => {
      const params = new URL(request.url).searchParams;
      const bindingId = params.get("sourceBindingId");
      const builderId = params.get("builderNodeId");
      const status = params.get("status");
      const limit = Number(params.get("limit") ?? 50);
      const data = allBuilds
        .filter((item) => !bindingId || item.sourceBindingId === bindingId)
        .filter((item) => !builderId || item.builderNodeId === builderId)
        .filter((item) => !status || item.status === status)
        .slice(0, limit);
      return ok({ data, nextCursor: null });
    }),
    http.get("*/api/docker/builds/:buildId/logs", () => wrapped(buildLog)),
    http.get("*/api/docker/builds/:buildId", ({ params }) => {
      const found = allBuilds.find((item) => item.id === params.buildId);
      return found ? wrapped(found) : notFound();
    }),
    http.get("*/api/docker/migrations", () => wrapped(migrations)),
    http.get("*/api/docker/sources/connectors", () => wrapped(sourceConnectors)),
    http.get("*/api/docker/nodes/:nodeId/source-resources/admission", () =>
      wrapped({ ready: true, code: null, message: null })
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:name/source/build-secrets", ({ params }) =>
      wrapped(buildSecrets[sourceFor(params, "container")?.id ?? ""] ?? [])
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:name/source", ({ params }) =>
      wrapped(sourceFor(params, "container"))
    ),
    http.get(
      "*/api/docker/nodes/:nodeId/deployments/:deploymentId/source/build-secrets",
      ({ params }) => wrapped(buildSecrets[sourceFor(params, "deployment")?.id ?? ""] ?? [])
    ),
    http.get("*/api/docker/nodes/:nodeId/deployments/:deploymentId/source", ({ params }) =>
      wrapped(sourceFor(params, "deployment"))
    ),
  ];
}
