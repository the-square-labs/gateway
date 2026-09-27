/**
 * Pages states beyond the populated tabs: the project the Create dialog makes,
 * projects in folders, a project without a domain, the Pages profile during
 * setup, manual deploy archives, a new deploy token, the Git connect wizard and
 * a failed build log. Seeds 22700-22899 belong to this file.
 */
import { gzipSync } from "fflate";
import { delay, type HttpHandler, HttpResponse, http } from "msw";
import type {
  DockerBuildLogChunk,
  DockerBuildSourceRepository,
  PageDeployment,
  PageDeployToken,
  PageDeployTokenCreated,
  PageProfile,
  PageProfileOptions,
  PageProject,
  PageProjectFolderTreeNode,
  PagesBuildDiscovery,
} from "@/types";
import { ok, wrapped } from "../../handlers";
import { people } from "../catalog";
import { pagesHandlers } from "../data/pages-handlers";
import { sourceConnectors } from "../docker/builds";
import { edgeNode } from "../nodes";
import { uiBootstrap } from "../shell";
import { ago, ahead, uuid } from "../time";
import {
  extraPageProjects,
  marketingBuilds,
  marketingDeployTokens,
  pagesExtraHandlers,
  pagesListRows,
} from "./pages";
import { PAGES_DOMAIN, pagesProfileConfigured, pagesProfileOptions } from "./pages-profile";
import { backgroundPrewarmHandlers } from "./prewarm";

const MiB = 1024 ** 2;
const KiB = 1024;

// ── Projects ─────────────────────────────────────────────────────────────

/** What Create Page Project makes: partner-portal on the Frankfurt edge, nothing deployed yet. */
export const partnerPortalProject: PageProject = {
  ...pagesListRows[0],
  id: uuid(22701),
  name: "partner-portal",
  slug: "partner-portal",
  previewHash: "b4n8r2kd7tqm",
  accessListId: null,
  description: null,
  appearanceColor: null,
  spaFallback: false,
  previewsEnabled: true,
  fallbackUrl: null,
  nodeId: edgeNode.id,
  folderId: null,
  sortOrder: 6,
  maxDeployments: 20,
  storageQuotaBytes: 1024 * MiB,
  storageUsedBytes: 0,
  nextDeploymentSequence: 1,
  deploymentCount: 0,
  tagCount: 0,
  routeCount: 0,
  primaryDomain: null,
  createdById: people[0].id,
  updatedById: null,
  createdAt: ago(1, "m"),
  updatedAt: ago(1, "m"),
};

/** design-system has no domain of its own: the header offers its latest immutable preview. */
export const designSystemProject = extraPageProjects[0];

function designDeployment(
  sequence: number,
  publicSlug: string,
  hoursAgo: number,
  overrides: Partial<PageDeployment> = {}
): PageDeployment {
  const createdAt = ago(hoursAgo, "h");
  return {
    id: uuid(22710 + sequence - 56),
    projectId: designSystemProject.id,
    sequence,
    publicSlug,
    previewHostname: `${publicSlug}.${PAGES_DOMAIN}`,
    status: "ready",
    artifactSha256: null,
    compressedSizeBytes: 14.2 * MiB,
    expandedSizeBytes: 38.6 * MiB,
    fileCount: 846,
    sourceMetadata: {
      provider: "github",
      repository: "northwind/design-system",
      ref: "refs/heads/main",
      actor: "Omar Haddad",
    },
    requestedTag: null,
    pinned: false,
    failureCode: null,
    failureMessage: null,
    createdById: null,
    createdAt,
    updatedAt: createdAt,
    readyAt: createdAt,
    deletedAt: null,
    expiresAt: null,
    credentialType: "deploy-token",
    ...overrides,
  };
}

export const designSystemDeployments: PageDeployment[] = [
  designDeployment(62, "f7kq2vn9xd4mtc8h", 5, {
    sourceMetadata: {
      provider: "github",
      repository: "northwind/design-system",
      ref: "refs/heads/main",
      commitSha: "3e9a1f07c2",
      actor: "Omar Haddad",
    },
  }),
  designDeployment(61, "m2wd8zt5qh1pkr6v", 27, {
    sourceMetadata: {
      provider: "github",
      repository: "northwind/design-system",
      ref: "refs/heads/main",
      commitSha: "b81c4d9e20",
      actor: "Lena Novak",
    },
  }),
  designDeployment(60, "c9vn3kx6pt2wq8jd", 50, {
    requestedTag: "v4-rc",
    pinned: true,
    sourceMetadata: {
      provider: "github",
      repository: "northwind/design-system",
      ref: "refs/tags/v4-rc",
      commitSha: "71fe2a3b95",
      actor: "Omar Haddad",
    },
  }),
  designDeployment(59, "r5hb1mz8wk3tq7nc", 76, {
    credentialType: "user",
    createdById: people[1].id,
    sourceMetadata: { provider: "manual" },
  }),
  designDeployment(58, "t8qd4nw2xv6kc1mh", 122, {
    sourceMetadata: {
      provider: "github",
      repository: "northwind/design-system",
      ref: "refs/heads/main",
      commitSha: "0c5d7e9f14",
      actor: "Maya Chen",
    },
  }),
];

// ── Folders ──────────────────────────────────────────────────────────────

function folder(seed: number, name: string, sortOrder: number): PageProjectFolderTreeNode {
  return {
    id: uuid(22740 + seed),
    name,
    parentId: null,
    sortOrder,
    depth: 0,
    createdAt: ago(80, "d"),
    updatedAt: ago(12, "d"),
    children: [],
  };
}

export const pageFolders: PageProjectFolderTreeNode[] = [
  folder(1, "Campaigns", 0),
  folder(2, "Product", 1),
];

const FOLDER_OF: Record<string, string> = {
  "autumn-campaign": pageFolders[0].id,
  "docs-portal": pageFolders[1].id,
  "design-system": pageFolders[1].id,
  "help-center": pageFolders[1].id,
};

/** The list rows filed into Campaigns and Product; marketing-site stays ungrouped. */
export const pagesFolderRows: PageProject[] = pagesListRows.map((project) => ({
  ...project,
  folderId: FOLDER_OF[project.slug] ?? null,
}));

// ── Pages profile (Settings → Features) ──────────────────────────────────

export { pagesProfileConfigured, pagesProfileOptions };

/** A fresh installation: Pages is off and nothing is chosen yet. */
export const pagesProfileDisabled: PageProfile = {
  ...pagesProfileConfigured,
  enabled: false,
  status: "disabled",
  domainId: null,
  nodeId: null,
  certificateId: null,
  overrideSameRegistrableDomain: false,
  overrideAcknowledgedById: null,
  overrideAcknowledgedAt: null,
  domain: null,
  node: null,
  certificate: null,
  isolation: null,
};

/** Pages profile answers; a disabled profile also hides Pages from the navigation. */
export function pagesProfileHandlers(profile: PageProfile) {
  return [
    http.get("*/api/pages/settings/profile", () => wrapped(profile)),
    http.get("*/api/pages/settings/options", () => wrapped(pagesProfileOptions)),
    ...(profile.enabled
      ? []
      : [
          http.get("*/api/ui/bootstrap", () =>
            wrapped({
              ...uiBootstrap,
              navigation: { ...uiBootstrap.navigation, pagesEnabled: false },
            })
          ),
        ]),
  ];
}

// ── Manual deploy archives ───────────────────────────────────────────────

const encoder = new TextEncoder();

/** Deterministic filler for binary assets (images, fonts, bundles). */
function filler(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const words = new Uint32Array(bytes.buffer, 0, Math.floor(size / 4));
  let state = seed >>> 0 || 1;
  for (let index = 0; index < words.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[index] = state >>> 0;
  }
  return bytes;
}

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

/** A ustar archive: one 512-byte header per file, the data padded to 512 bytes. */
function tar(entries: Array<[path: string, bytes: Uint8Array]>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, bytes] of entries) {
    const header = new Uint8Array(512);
    header.set(text(path), 0);
    header.set(text("0000644\0"), 100);
    header.set(text(`${bytes.length.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = "0".charCodeAt(0);
    header.set(text("ustar\0"), 257);
    const data = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    data.set(bytes);
    blocks.push(header, data);
  }
  blocks.push(new Uint8Array(1024));
  const output = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.length;
  }
  return output;
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northwind</title></head>
<body><div id="app"></div><script type="module" src="/assets/index-4f2a9c.js"></script></body></html>
`;

/** The static build of marketing-site: pages, a bundle, fonts and images, about 13 MB. */
function siteEntries(root = ""): Array<[string, Uint8Array]> {
  const entries: Array<[string, Uint8Array]> = [
    [`${root}index.html`, text(INDEX_HTML)],
    [`${root}404.html`, text(INDEX_HTML)],
    [`${root}robots.txt`, text("User-agent: *\nAllow: /\n")],
    [`${root}sitemap.xml`, text('<?xml version="1.0"?><urlset></urlset>\n')],
    [`${root}assets/index-4f2a9c.js`, filler(612 * KiB, 1)],
    [`${root}assets/index-8d31e7.css`, filler(88 * KiB, 2)],
  ];
  for (const page of ["about", "pricing", "careers", "contact", "security", "legal"]) {
    entries.push([`${root}${page}/index.html`, text(INDEX_HTML)]);
  }
  for (let index = 0; index < 4; index += 1) {
    entries.push([`${root}fonts/inter-${index}.woff2`, filler(48 * KiB, 10 + index)]);
  }
  for (let index = 0; index < 64; index += 1) {
    entries.push([`${root}images/hero-${index}.webp`, filler(196 * KiB, 100 + index)]);
  }
  return entries;
}

/** Stored (level 0) like already-compressed assets are, so the archive keeps its real size. */
function gzipFile(name: string, entries: Array<[string, Uint8Array]>): File {
  const compressed = gzipSync(tar(entries), { level: 0 });
  // An ArrayBuffer-backed copy, which File accepts as a BlobPart.
  const bytes = new Uint8Array(compressed.length);
  bytes.set(compressed);
  return new File([bytes.buffer], name, { type: "application/gzip", lastModified: Date.now() });
}

export function siteArchive(): File {
  return gzipFile("marketing-site-hotfix.tar.gz", siteEntries());
}

/** Packed with its dist/ folder, so index.html is not at the archive root. */
export function wrappedSiteArchive(): File {
  return gzipFile("marketing-site-dist.tar.gz", siteEntries("dist/").slice(0, 12));
}

/** Uploads the manual deploy dialog makes; the second 8 MiB chunk never completes. */
export function manualDeployHandlers() {
  const CHUNK = 8 * MiB;
  let declaredSize = 0;
  return [
    http.post("*/api/pages-deploy/deployments", async ({ request }) => {
      const body = (await request.json()) as { declaredSizeBytes: number; projectId: string };
      declaredSize = body.declaredSizeBytes;
      const createdAt = ago(0, "s");
      return wrapped({
        deployment: {
          id: uuid(22761),
          projectId: body.projectId,
          sequence: 44,
          publicSlug: "k3vz8qm1tw5nd9hx",
          previewHostname: null,
          status: "uploading",
          artifactSha256: null,
          compressedSizeBytes: declaredSize,
          expandedSizeBytes: 0,
          fileCount: 0,
          sourceMetadata: { provider: "manual" },
          requestedTag: "production",
          pinned: false,
          failureCode: null,
          failureMessage: null,
          createdById: people[0].id,
          createdAt,
          updatedAt: createdAt,
          readyAt: null,
          deletedAt: null,
          expiresAt: null,
          credentialType: "user",
        } satisfies PageDeployment,
        upload: { id: uuid(22762), offset: 0, expiresAt: ahead(1, "d") },
      });
    }),
    http.put("*/api/pages-deploy/uploads/:uploadId/chunks", async ({ request }) => {
      const offset = Number(request.headers.get("Upload-Offset") ?? 0);
      // The artboard shows the upload part-way: the second chunk stays in flight.
      if (offset > 0) await delay("infinite");
      return wrapped({ offset: Math.min(offset + CHUNK, declaredSize) });
    }),
  ];
}

// ── Deploy tokens ────────────────────────────────────────────────────────

export const createdDeployToken: PageDeployTokenCreated = {
  id: uuid(22771),
  projectId: pagesListRows[0].id,
  name: "GitLab CI (staging)",
  tokenPrefix: "gwpd_S7tg",
  allowedTagPatterns: ["staging"],
  allowUserTag: true,
  lastUsedAt: null,
  expiresAt: "2027-03-31T09:00:00.000Z",
  revokedAt: null,
  createdAt: ago(0, "s"),
  token: "gwpd_S7tg_EXAMPLE-ONLY-deploy-token-0000000000000000",
};

/** Create token answers the new secret once; the list then includes the token. */
export function deployTokenHandlers() {
  const tokens: PageDeployToken[] = [...marketingDeployTokens];
  return [
    http.post("*/api/pages/:id/tokens", () => {
      const { token: _secret, ...listed } = createdDeployToken;
      tokens.unshift(listed);
      return wrapped(createdDeployToken);
    }),
    http.get("*/api/pages/:id/tokens", ({ params }) =>
      wrapped(params.id === createdDeployToken.projectId ? tokens : [])
    ),
  ];
}

// ── Git source: connect wizard, Build now ────────────────────────────────

const [gitlabConnector] = sourceConnectors;

function repository(remoteId: string, name: string): DockerBuildSourceRepository {
  return {
    connectorId: gitlabConnector.id,
    connectorName: gitlabConnector.name,
    projectId: remoteId,
    provider: "gitlab",
    remoteId,
    fullPath: `northwind/${name}`,
    name,
    webUrl: `https://gitlab.example.com/northwind/${name}`,
    defaultBranch: "main",
    archived: false,
  };
}

export const pagesRepositories: DockerBuildSourceRepository[] = [
  repository("5120", "partner-portal"),
  repository("4821", "marketing-site"),
  repository("4907", "design-system"),
  repository("5033", "help-center"),
];

export const partnerPortalDiscovery: PagesBuildDiscovery = {
  commitSha: "6a2f9d18c4e07b53a1d9f2c6e8b04a7d3f1c5e92",
  packagePath: "package.json",
  scripts: {
    build: "vite build",
    "build:staging": "vite build --mode staging",
    dev: "vite",
    preview: "vite preview",
    test: "vitest run",
  },
  packageManagers: ["pnpm"],
  preferredPackageManager: "pnpm",
  packageManagerVersion: "9.12.0",
};

export function connectRepositoryHandlers() {
  return [
    http.get("*/api/docker/sources/connectors", () => wrapped(sourceConnectors)),
    http.get("*/api/pages/projects/:id/source/connectors/:connectorId/repositories", ({ params }) =>
      wrapped(params.connectorId === gitlabConnector.id ? pagesRepositories : [])
    ),
    http.post("*/api/pages/projects/:id/source/discovery", () => wrapped(partnerPortalDiscovery)),
  ];
}

/** Build now on an installation whose only Build Worker is disconnected. */
export function noBuildWorkerHandlers() {
  return [
    http.post("*/api/pages/projects/:id/source/builds", () =>
      HttpResponse.json(
        {
          code: "NO_BUILD_WORKER_AVAILABLE",
          message: "No connected Build Worker can run this build",
        },
        { status: 409 }
      )
    ),
  ];
}

// ── Build log ────────────────────────────────────────────────────────────

const failedBuild = marketingBuilds.find((build) => build.status === "failed")!;

export const failedBuildLog: DockerBuildLogChunk[] = [
  "Cloning https://gitlab.example.com/northwind/marketing-site.git at c71d5e3a",
  "Using Node.js 22 with pnpm 9.12.0",
  "$ pnpm install --frozen-lockfile",
  "Lockfile is up to date, resolution step is skipped",
  "Packages: +612",
  "Done in 9.8s",
  "$ pnpm run build",
  "> marketing-site@2.8.1 build /workspace",
  "> astro build",
  '[build] output: "static"',
  "[build] Collecting build info...",
  "[vite] ✓ 214 modules transformed.",
  '[vite] Rollup failed to resolve import "./i18n/de.json" from "src/lib/i18n.ts".',
  "Error: Cannot find module './i18n/de.json'",
  " ELIFECYCLE  Command failed with exit code 1.",
  "Build failed: pnpm run build exited with code 1",
].map((content, sequence) => ({
  buildId: failedBuild.id,
  sequence,
  content: `${content}\n`,
  byteLength: content.length + 1,
  createdAt: failedBuild.completedAt ?? ago(26, "h"),
}));

export function buildLogHandlers() {
  return [
    http.get("*/api/docker/builds/:buildId/logs", ({ params }) =>
      wrapped(params.buildId === failedBuild.id ? failedBuildLog : [])
    ),
    http.get("*/api/docker/builds/:buildId", ({ params }) => {
      const found = marketingBuilds.find((build) => build.id === params.buildId);
      return found ? wrapped(found) : HttpResponse.json({ message: "Not found" }, { status: 404 });
    }),
  ];
}

// ── Handler sets ─────────────────────────────────────────────────────────

/** Every Pages project of the installation plus partner-portal, freshly created. */
export const pagesRowsWithNew: PageProject[] = [...pagesListRows, partnerPortalProject];

/** A project screen: the populated fixtures, `extra` checked first. */
export function pagesProjectHandlers(...extra: HttpHandler[]) {
  return [
    ...extra,
    http.get("*/api/pages/:id/deployments", ({ params, request }) =>
      params.id === designSystemProject.id
        ? ok({
            data: designSystemDeployments,
            pagination: {
              page: 1,
              limit: Number(new URL(request.url).searchParams.get("limit") ?? 50),
              total: designSystemDeployments.length,
              totalPages: 1,
            },
          })
        : undefined
    ),
    ...pagesExtraHandlers(),
    ...pagesHandlers({ projects: pagesRowsWithNew }),
    ...backgroundPrewarmHandlers(),
  ];
}
