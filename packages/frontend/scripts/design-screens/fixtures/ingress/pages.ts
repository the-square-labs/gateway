/**
 * Pages screens beyond Deployments and Tags: more projects for the list, the
 * GitLab source and build history of marketing-site, its deploy tokens and its
 * runtime configuration. Seeds 22300-22499 belong to this file.
 */
import { http } from "msw";
import type {
  DockerBuild,
  DockerSourceBinding,
  PageDeployToken,
  PageProject,
  PageRuntimeConfigsResponse,
} from "@/types";
import { ok, wrapped } from "../../handlers";
import { people } from "../catalog";
import { docsProject, marketingProject, marketingTags, pageProjectRows } from "../data/pages";
import { nodeBySlug } from "../nodes";
import { ago, ahead, uuid } from "../time";

const MiB = 1024 ** 2;

/**
 * Merge-request ref. Built at runtime so Tailwind's source scan, which also
 * reads this folder, does not read a margin utility (mr + number) into the stylesheet.
 */
const mrRef = (number: number) => ["mr", number].join("-");

function project(
  seed: number,
  overrides: Partial<PageProject> & Pick<PageProject, "name">
): PageProject {
  return {
    ...docsProject,
    id: uuid(22300 + seed),
    slug: overrides.name,
    previewHash: `q${seed}x7c2m9v4lw`,
    description: null,
    appearanceColor: "purple",
    spaFallback: true,
    primaryDomain: null,
    routeCount: 0,
    sortOrder: 1 + seed,
    createdById: people[1].id,
    updatedById: people[1].id,
    ...overrides,
  };
}

export const extraPageProjects: PageProject[] = [
  project(1, {
    name: "design-system",
    description: "Component Storybook for the product team",
    appearanceColor: "purple",
    storageUsedBytes: 188 * MiB,
    deploymentCount: 12,
    tagCount: 4,
    nextDeploymentSequence: 63,
    createdAt: ago(60, "d"),
    updatedAt: ago(5, "h"),
  }),
  project(2, {
    name: "help-center",
    description: "Customer help articles",
    appearanceColor: "orange",
    primaryDomain: "help.example.com",
    routeCount: 1,
    storageUsedBytes: 1_890 * MiB,
    storageQuotaBytes: 2_048 * MiB,
    deploymentCount: 24,
    tagCount: 2,
    nextDeploymentSequence: 131,
    createdAt: ago(210, "d"),
    updatedAt: ago(3, "d"),
  }),
  project(3, {
    name: "autumn-campaign",
    description: "Landing page for the autumn promotion",
    appearanceColor: "red",
    nodeId: nodeBySlug("edge-ams-1")!.id,
    storageUsedBytes: 24 * MiB,
    deploymentCount: 3,
    tagCount: 1,
    nextDeploymentSequence: 4,
    createdAt: ago(9, "d"),
    updatedAt: ago(9, "d"),
  }),
];

export const pagesListRows: PageProject[] = [...pageProjectRows, ...extraPageProjects];

// ── Source and builds ────────────────────────────────────────────────────

const REPOSITORY = "northwind/marketing-site";
const SHAS = [
  "9f3c2a17e4b8d5061c7a2e9f0b4d6c8a1e3f5b7d",
  "4be81c09d7a2f36e5b1c8d0a9f7e2c4b6d8a0f13",
  "c71d5e3a9b0f2c48e6a1d7b3f9c5e0a2b4d6f8e1",
  "0a6f4c2e8b1d3f5a7c9e0b2d4f6a8c1e3b5d7f92",
  "e25b7d9f1a3c5e7b9d0f2a4c6e8b1d3f5a7c9e04",
  "7d0e2f4a6c8b1d3e5f7a9c0b2d4e6f8a1c3e5b76",
];

export const marketingSource: DockerSourceBinding = {
  id: uuid(22401),
  target: {
    kind: "pages_project",
    nodeId: marketingProject.nodeId ?? undefined,
    pageProjectId: marketingProject.id,
  },
  connectorId: uuid(22402),
  projectId: "4821",
  provider: "gitlab",
  repositoryRemoteId: "4821",
  repositoryFullPath: REPOSITORY,
  repositoryCloneUrl: `https://gitlab.example.com/${REPOSITORY}.git`,
  branch: "main",
  dockerfilePath: "",
  contextPath: ".",
  composeFilePath: null,
  composeVariables: {},
  composeSecretKeys: [],
  autoBuild: true,
  autoDeploy: true,
  buildArgs: { PUBLIC_SITE_URL: "https://www.example.com" },
  buildSecretNames: ["SENTRY_AUTH_TOKEN"],
  applicationRoot: ".",
  packageManager: "pnpm",
  packageManagerVersion: "9.12.0",
  nodeVersion: "22",
  buildScript: "build",
  artifactDirectory: "dist",
  publishTag: "production",
  policy: { vulnerabilityThreshold: "disabled", vulnerabilityScope: "all" },
  desiredCommitSha: SHAS[0],
  deployedCommitSha: SHAS[0],
  lastResolvedAt: ago(2, "h"),
  lastPollAt: ago(4, "m"),
  lastPollError: null,
  webhookConfiguredAt: ago(120, "d"),
  lastWebhookAt: ago(2, "h"),
  lastWebhookError: null,
  createdAt: ago(120, "d"),
  updatedAt: ago(2, "h"),
};

const DIGESTS = [
  "sha256:5d1f0c9a7e3b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f",
  "sha256:a3c5e7b9d1f2a4c6e8b0d2f4a6c8e1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4",
  "sha256:e9b7d5f3a1c2e4b6d8f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1b3d5f7a9c0e2b4",
  "sha256:1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1b3d",
];

/** A finished build: `minutesAgo` it completed after `seconds` of work. */
function build(
  seed: number,
  overrides: Partial<DockerBuild> & Pick<DockerBuild, "status" | "commitSha">,
  minutesAgo: number,
  seconds: number
): DockerBuild {
  const completedAt = ago(minutesAgo, "m");
  const startedAt = new Date(Date.parse(completedAt) - seconds * 1000).toISOString();
  const queuedAt = new Date(Date.parse(startedAt) - 4_000).toISOString();
  const artifactDigest = overrides.status === "succeeded" ? DIGESTS[seed % DIGESTS.length] : null;
  return {
    id: uuid(22410 + seed),
    sourceBindingId: marketingSource.id,
    batchId: null,
    serviceName: null,
    provider: "gitlab",
    trigger: "gitlab_push",
    repositoryFullPath: REPOSITORY,
    ref: "main",
    builderNodeId: nodeBySlug("apps-1")?.id ?? null,
    builderName: "apps-1",
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: { elapsedSeconds: seconds },
    artifact: artifactDigest
      ? {
          id: uuid(22420 + seed),
          buildId: uuid(22410 + seed),
          registryRepository: `pages/${marketingProject.slug}`,
          digest: artifactDigest,
          platform: "linux/amd64",
          sizeBytes: 38 * MiB,
          status: "ready",
          sbomDigest: null,
          provenanceDigest: null,
          scanSummary: null,
          policyDecision: "approved",
          policyReason: null,
          verifiedAt: completedAt,
          createdAt: completedAt,
        }
      : null,
    target: {
      kind: "pages_project",
      nodeId: marketingProject.nodeId ?? undefined,
      pageProjectId: marketingProject.id,
      name: marketingProject.name,
    },
    createdAt: queuedAt,
    queuedAt,
    startedAt,
    completedAt,
    ...overrides,
  };
}

export const marketingBuilds: DockerBuild[] = [
  build(1, { status: "succeeded", commitSha: SHAS[0], ref: "v2.8.1" }, 119, 164),
  build(2, { status: "succeeded", commitSha: SHAS[1], ref: mrRef(121) }, 9 * 60 + 12, 151),
  build(
    3,
    {
      status: "failed",
      commitSha: SHAS[2],
      errorCode: "build_script_failed",
      errorMessage: "pnpm run build exited with code 1: Cannot find module './i18n/de.json'",
    },
    26 * 60,
    48
  ),
  build(4, { status: "succeeded", commitSha: SHAS[3], trigger: "manual" }, 3 * 24 * 60, 172),
  build(5, { status: "succeeded", commitSha: SHAS[4], ref: "v2.8.0" }, 6 * 24 * 60, 158),
  build(6, { status: "cancelled", commitSha: SHAS[5], trigger: "manual" }, 8 * 24 * 60, 21),
];

// ── Deploy tokens ────────────────────────────────────────────────────────

export const marketingDeployTokens: PageDeployToken[] = [
  {
    id: uuid(22431),
    projectId: marketingProject.id,
    name: "GitLab CI (releases)",
    tokenPrefix: "gwpd_7Kq2",
    allowedTagPatterns: ["production", "v*"],
    allowUserTag: false,
    lastUsedAt: ago(2, "h"),
    expiresAt: ahead(300, "d"),
    revokedAt: null,
    createdAt: ago(120, "d"),
  },
  {
    id: uuid(22432),
    projectId: marketingProject.id,
    name: "GitLab CI (merge requests)",
    tokenPrefix: "gwpd_M3xa",
    allowedTagPatterns: ["mr-*"],
    allowUserTag: true,
    lastUsedAt: ago(9, "h"),
    expiresAt: ahead(300, "d"),
    revokedAt: null,
    createdAt: ago(120, "d"),
  },
  {
    id: uuid(22433),
    projectId: marketingProject.id,
    name: "Local preview (Omar)",
    tokenPrefix: "gwpd_Pv90",
    allowedTagPatterns: [],
    allowUserTag: false,
    lastUsedAt: ago(19, "d"),
    expiresAt: ahead(11, "d"),
    revokedAt: null,
    createdAt: ago(80, "d"),
  },
];

// ── Runtime configuration ────────────────────────────────────────────────

const defaultSource = `{
  "apiBaseUrl": "https://api.example.com/v1",
  "analytics": { "enabled": true, "siteId": "northwind-www" },
  "features": { "pricingV2": false, "newsletter": true },
  "supportEmail": "support@example.com"
}`;

const productionTag = marketingTags.find((tag) => tag.name === "production")!;

export const marketingRuntimeConfigs: PageRuntimeConfigsResponse = {
  default: {
    id: uuid(22441),
    projectId: marketingProject.id,
    tagId: null,
    source: defaultSource,
    generation: 6,
    updatedAt: ago(4, "d"),
    updatedById: people[1].id,
  },
  overrides: [
    {
      id: uuid(22442),
      projectId: marketingProject.id,
      tagId: productionTag.id,
      source: defaultSource.replace('"pricingV2": false', '"pricingV2": true'),
      generation: 2,
      updatedAt: ago(1, "d"),
      updatedById: people[0].id,
    },
  ],
  tags: marketingTags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    system: tag.system,
    hasOverride: tag.id === productionTag.id,
  })),
};

/** Handlers for the extra Pages screens; pass them before `pagesHandlers()`. */
export function pagesExtraHandlers() {
  return [
    http.get("*/api/pages/projects/:id/source", ({ params }) =>
      wrapped(params.id === marketingProject.id ? marketingSource : null)
    ),
    http.get("*/api/docker/builds", ({ request }) => {
      const url = new URL(request.url);
      const binding = url.searchParams.get("sourceBindingId");
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      const rows = binding === marketingSource.id ? marketingBuilds.slice(0, limit) : [];
      return ok({ data: rows, nextCursor: null });
    }),
    http.get("*/api/pages/projects/:id/source/build-secrets", () =>
      wrapped([
        {
          id: uuid(22451),
          name: "SENTRY_AUTH_TOKEN",
          createdAt: ago(120, "d"),
          updatedAt: ago(30, "d"),
        },
      ])
    ),
    http.get("*/api/pages/:id/tokens", ({ params }) =>
      wrapped(params.id === marketingProject.id ? marketingDeployTokens : [])
    ),
    http.get("*/api/pages/:id/runtime-configs", () => wrapped(marketingRuntimeConfigs)),
  ];
}
