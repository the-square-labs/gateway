import { HttpResponse, http } from "msw";
import type { NodeDetail, ProxyHost } from "@/types";
import { containers, people, routes } from "../catalog";
import { appsNode, edgeNode, nodeById, nodeBySlug, nodeDetail } from "../nodes";
import { ago, uuid } from "../time";
import { ok, wrapped } from "../../handlers";
import { certificateAuthorities } from "../dashboard";
import { sslCertificates } from "./ssl";
import { nodeListHandlers } from "./nodes";
import { paginate } from "./domains";

const appsNode2 = nodeBySlug("apps-2")!;
const edgeAms = nodeBySlug("edge-ams-1")!;

/** What an Ingress daemon reports about its host, so the Runtime and System panels fill in. */
const ingressCapabilities = {
  nginxVersion: "1.27.2",
  cpuModel: "AMD EPYC 7543P 32-Core Processor",
  cpuCores: 4,
  architecture: "x86_64",
  kernelVersion: "6.8.0-45-generic",
};

/** The shared node detail, with the host facts the daemon reports for Ingress nodes. */
export function edgeNodeDetail(slugOrId: string): NodeDetail | undefined {
  const target = nodeBySlug(slugOrId) ?? nodeById(slugOrId);
  if (!target) return undefined;
  const detail = nodeDetail(target);
  return target.type === "nginx"
    ? { ...detail, capabilities: { ...detail.capabilities, ...ingressCapabilities } }
    : detail;
}

const route = (slug: string) => routes.find((item) => item.slug === slug)!;
const container = (name: string) => containers.find((item) => item.name === name)!;
const certFor = (domain: string) =>
  sslCertificates.find((cert) => cert.domainNames.includes(domain))?.id ?? null;

type HostSeed = Partial<ProxyHost> & { slug: string; nodeId: string };

function proxyHost(seed: HostSeed): ProxyHost {
  const catalog = route(seed.slug);
  const domainNames = [...catalog.domains];
  const health = catalog.enabled ? catalog.health : "disabled";
  return {
    id: catalog.id,
    type: "proxy",
    domainNames,
    enabled: catalog.enabled,
    maintenanceEnabled: false,
    maintenanceStartedAt: null,
    upstreamKind: "manual",
    forwardHost: null,
    forwardPort: null,
    forwardScheme: "http",
    sslEnabled: true,
    sslForced: true,
    http2Support: true,
    sslCertificateId: certFor(domainNames[0]),
    internalCertificateId: null,
    websocketSupport: false,
    redirectUrl: null,
    redirectStatusCode: 301,
    customHeaders: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitOptions: null,
    customRewrites: [],
    advancedConfig: null,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    folderId: null,
    sortOrder: 0,
    nginxTemplateId: null,
    templateVariables: {},
    healthCheckEnabled: true,
    healthCheckUrl: "/healthz",
    healthCheckInterval: 30,
    healthCheckExpectedStatus: 200,
    healthCheckExpectedBody: null,
    healthCheckBodyMatchMode: "includes",
    healthCheckSlowThreshold: 800,
    healthStatus: health as ProxyHost["healthStatus"],
    effectiveHealthStatus: health,
    lastHealthCheckAt: catalog.enabled ? ago(30, "s") : null,
    isSystem: false,
    systemKind: null,
    createdById: people[0].id,
    createdAt: ago(180, "d"),
    updatedAt: ago(3, "d"),
    ...seed,
  } as ProxyHost;
}

const dockerTarget = (
  name: string,
  node: typeof appsNode,
  port: number
): Omit<Partial<ProxyHost>, "nodeId"> => ({
  upstreamKind: "docker_container",
  dockerNodeId: node.id,
  dockerNodeSlug: node.slug,
  dockerNodeAppearanceColor: node.appearanceColor as ProxyHost["dockerNodeAppearanceColor"],
  dockerContainerName: container(name).name,
  dockerContainerPort: port,
  dockerProtocol: "tcp",
});

/** Routes served by the two Ingress nodes (catalog routes, with their upstreams). */
export const proxyHosts: ProxyHost[] = [
  proxyHost({
    slug: "app",
    nodeId: edgeNode.id,
    ...dockerTarget("web", appsNode, 3000),
    websocketSupport: true,
  }),
  proxyHost({
    slug: "api",
    nodeId: edgeNode.id,
    upstreamKind: "docker_deployment",
    dockerNodeId: appsNode.id,
    dockerNodeSlug: appsNode.slug,
    dockerNodeAppearanceColor: appsNode.appearanceColor as ProxyHost["dockerNodeAppearanceColor"],
    dockerDeploymentId: uuid(41401),
    dockerDeploymentName: "api",
    dockerContainerPort: 8080,
    rateLimitEnabled: true,
  }),
  proxyHost({
    slug: "auth",
    nodeId: edgeNode.id,
    forwardHost: "10.20.0.31",
    forwardPort: 8080,
  }),
  proxyHost({ slug: "grafana", nodeId: edgeNode.id, ...dockerTarget("grafana", appsNode2, 3000) }),
  proxyHost({
    slug: "legacy-admin",
    nodeId: edgeNode.id,
    forwardHost: "10.20.0.45",
    forwardPort: 8443,
    forwardScheme: "https",
    sslCertificateId: null,
    sslForced: false,
  }),
  proxyHost({
    slug: "staging-app",
    nodeId: edgeNode.id,
    ...dockerTarget("web", appsNode2, 3000),
    dockerContainerName: "web-staging",
  }),
  proxyHost({
    slug: "status",
    nodeId: edgeAms.id,
    forwardHost: "10.20.1.20",
    forwardPort: 3001,
  }),
  proxyHost({
    slug: "docs",
    nodeId: edgeAms.id,
    forwardHost: "10.20.1.21",
    forwardPort: 8000,
  }),
  proxyHost({
    slug: "shop",
    nodeId: edgeAms.id,
    forwardHost: "10.20.1.22",
    forwardPort: 443,
    forwardScheme: "https",
  }),
];

/** Node detail endpoints: the detail read model, its health history and hosting projection. */
export function nodeDetailHandlers() {
  const detail = (key: string) => {
    const found = edgeNodeDetail(key);
    return found ? wrapped(found) : HttpResponse.json({}, { status: 404 });
  };
  return [
    ...nodeListHandlers(),
    http.get("*/api/nodes/by-slug/:slug", ({ params }) => detail(String(params.slug))),
    http.get("*/api/nodes/:id/health-history", ({ params }) => {
      const target = nodeById(String(params.id));
      return target ? wrapped(target.healthHistory ?? []) : HttpResponse.json({}, { status: 404 });
    }),
    http.get("*/api/nodes/:id", ({ params }) => {
      // Leave /api/nodes/folders to the shared handler.
      if (params.id === "folders") return undefined;
      return detail(String(params.id));
    }),
    // Self-managed hosts have no hosting binding; the server answers null.
    http.get("*/api/hosting/nodes/:id", () => HttpResponse.json(null)),
    http.get("*/api/proxy-hosts", ({ request }) => {
      const url = new URL(request.url);
      const nodeId = url.searchParams.get("nodeId");
      return ok(paginate(proxyHosts.filter((host) => !nodeId || host.nodeId === nodeId), url));
    }),
    // Background prefetches that start once the page revealed.
    http.get("*/api/cas", () => HttpResponse.json(certificateAuthorities)),
    http.get("*/api/proxy-host-folders/grouped", () =>
      wrapped({ folders: [], ungroupedHosts: proxyHosts, totalHosts: proxyHosts.length })
    ),
  ];
}

