/**
 * Pages projects of the fictional installation. marketing-site is served on
 * its own domain from the Frankfurt edge and deploys from GitLab: release tags
 * publish production, merge requests publish expiring previews.
 */
import type {
  PageDeployment,
  PageDeploymentSourceMetadata,
  PageProject,
  PageProjectPlacementOption,
  PageTag,
} from "@/types";
import { pageProjects, people } from "../catalog";
import { edgeNode, nodeBySlug } from "../nodes";
import { ago, ahead, uuid } from "../time";

/**
 * Merge-request preview tag. Built at runtime so Tailwind's source scan, which
 * also reads this folder, does not read a margin utility (mr + number) into the product stylesheet.
 */
const mrTag = (number: number) => ["mr", number].join("-");

const MiB = 1024 ** 2;
const PAGES_DOMAIN = "pages.example.com";

const [marketingCatalog, docsCatalog] = pageProjects;

export const marketingProject: PageProject = {
  id: marketingCatalog.id,
  name: marketingCatalog.name,
  slug: marketingCatalog.slug,
  previewHash: "k7m2q9xw4dfa",
  accessListId: null,
  description: "Public website at www.example.com",
  appearanceColor: "blue",
  spaFallback: false,
  previewsEnabled: true,
  fallbackUrl: null,
  nodeId: edgeNode.id,
  migrationSourceNodeId: null,
  migrationTargetNodeId: null,
  migrationStatus: null,
  migrationGeneration: 0,
  migrationError: null,
  folderId: null,
  sortOrder: 0,
  maxDeployments: 25,
  storageQuotaBytes: 2048 * MiB,
  storageUsedBytes: 312 * MiB,
  nextDeploymentSequence: 44,
  deploymentCount: 7,
  tagCount: 5,
  routeCount: 2,
  primaryDomain: "www.example.com",
  createdById: people[0].id,
  updatedById: people[1].id,
  createdAt: ago(140, "d"),
  updatedAt: ago(2, "h"),
};

export const docsProject: PageProject = {
  ...marketingProject,
  id: docsCatalog.id,
  name: docsCatalog.name,
  slug: docsCatalog.slug,
  previewHash: "p3v8n1c6ztrh",
  description: "Product documentation",
  appearanceColor: "green",
  spaFallback: true,
  nodeId: nodeBySlug("edge-ams-1")!.id,
  sortOrder: 1,
  storageUsedBytes: 96 * MiB,
  nextDeploymentSequence: 19,
  deploymentCount: 5,
  tagCount: 3,
  routeCount: 1,
  primaryDomain: "docs.example.org",
  createdAt: ago(90, "d"),
  updatedAt: ago(1, "d"),
};

const repository = "northwind/marketing-site";

function gitSource(ref: string, commitSha: string, actor: string): PageDeploymentSourceMetadata {
  return { provider: "gitlab", repository, ref, commitSha, actor };
}

function deployment(
  sequence: number,
  publicSlug: string,
  overrides: Partial<PageDeployment>
): PageDeployment {
  const createdAt = overrides.createdAt ?? ago(sequence, "d");
  return {
    id: uuid(5100 + sequence),
    projectId: marketingProject.id,
    sequence,
    publicSlug,
    previewHostname: `${publicSlug}.${PAGES_DOMAIN}`,
    status: "ready",
    artifactSha256: null,
    compressedSizeBytes: 18.4 * MiB,
    expandedSizeBytes: 46.2 * MiB,
    fileCount: 1_284,
    sourceMetadata: {},
    requestedTag: null,
    pinned: false,
    failureCode: null,
    failureMessage: null,
    createdById: people[0].id,
    createdAt,
    updatedAt: createdAt,
    readyAt: createdAt,
    deletedAt: null,
    expiresAt: null,
    credentialType: "deploy-token",
    ...overrides,
  };
}

export const marketingDeployments: PageDeployment[] = [
  deployment(43, "r4tk8wz2mq6hbn3c", {
    status: "staging",
    previewHostname: null,
    readyAt: null,
    requestedTag: mrTag(124),
    sourceMetadata: {
      ...gitSource("refs/merge-requests/124/head", "e1b7c40d9a", "Lena Novak"),
      mergeRequest: "!124",
    },
    createdAt: ago(3, "m"),
    expiresAt: ahead(7, "d"),
  }),
  deployment(42, "h2x9cv7pl4dq8wme", {
    requestedTag: "v2.8.1",
    pinned: true,
    sourceMetadata: gitSource("refs/tags/v2.8.1", "9f2c1ab83e", "Maya Chen"),
    createdAt: ago(2, "h"),
    compressedSizeBytes: 18.6 * MiB,
    fileCount: 1_291,
  }),
  deployment(41, "n6fj3tq8zr1kxv5b", {
    requestedTag: mrTag(121),
    sourceMetadata: {
      ...gitSource("refs/merge-requests/121/head", "5d0e8f217c", "Omar Haddad"),
      mergeRequest: "!121",
    },
    createdAt: ago(9, "h"),
    expiresAt: ahead(6, "d"),
  }),
  deployment(40, "w8dq2mn5ch7tzk4r", {
    status: "failed",
    previewHostname: null,
    readyAt: null,
    requestedTag: mrTag(119),
    failureCode: "ARTIFACT_INVALID",
    failureMessage: "Archive entry ../.env points outside the site root",
    sourceMetadata: {
      ...gitSource("refs/merge-requests/119/head", "b37a91c0e4", "Sam Patel"),
      mergeRequest: "!119",
    },
    createdAt: ago(1, "d"),
    compressedSizeBytes: 17.9 * MiB,
    expiresAt: ahead(5, "d"),
  }),
  deployment(39, "c5vb9kx3pw2nq7ht", {
    requestedTag: "v2.8.0",
    sourceMetadata: gitSource("refs/tags/v2.8.0", "71ad6e4f02", "Maya Chen"),
    createdAt: ago(4, "d"),
    compressedSizeBytes: 18.2 * MiB,
    fileCount: 1_276,
  }),
  deployment(38, "t3zm6rq9dk1xf8wc", {
    requestedTag: mrTag(116),
    sourceMetadata: {
      ...gitSource("refs/merge-requests/116/head", "2c9f5b7a18", "Lena Novak"),
      mergeRequest: "!116",
    },
    createdAt: ago(5, "d"),
    expiresAt: ahead(2, "d"),
  }),
  deployment(37, "q9pk4hw7vn2cz6md", {
    requestedTag: "v2.7.4",
    pinned: true,
    sourceMetadata: gitSource("refs/tags/v2.7.4", "c8e03d1b6f", "Omar Haddad"),
    createdAt: ago(12, "d"),
    compressedSizeBytes: 17.1 * MiB,
    fileCount: 1_240,
  }),
];

function tagPreview(name: string) {
  const hostname = `${marketingProject.previewHash}-${name.replaceAll(".", "-")}.${PAGES_DOMAIN}`;
  return { hostname, url: `https://${hostname}`, status: "ready" as const, reason: null };
}

function tag(name: string, target: PageDeployment, generation: number, system = false): PageTag {
  return {
    id: uuid(5200 + target.sequence * 3 + generation),
    projectId: marketingProject.id,
    name,
    system,
    generation,
    deployment: {
      id: target.id,
      sequence: target.sequence,
      publicSlug: target.publicSlug,
      status: target.status,
    },
    preview: tagPreview(name),
    createdAt: ago(120, "d"),
    updatedAt: target.createdAt,
  };
}

const bySequence = (sequence: number) =>
  marketingDeployments.find((item) => item.sequence === sequence)!;

export const marketingTags: PageTag[] = [
  tag("latest", bySequence(42), 58, true),
  tag("production", bySequence(42), 21),
  tag("v2.8.1", bySequence(42), 1),
  tag("v2.8.0", bySequence(39), 1),
  tag(mrTag(121), bySequence(41), 3),
];

export const pagesPlacementOptions: PageProjectPlacementOption[] = [
  {
    id: edgeNode.id,
    displayName: edgeNode.displayName,
    hostname: edgeNode.hostname,
    status: "online",
    pagesCapable: true,
  },
  {
    id: nodeBySlug("edge-ams-1")!.id,
    displayName: "Edge Amsterdam",
    hostname: "edge-ams-1",
    status: "online",
    pagesCapable: true,
  },
];

export const pageProjectRows: PageProject[] = [marketingProject, docsProject];
