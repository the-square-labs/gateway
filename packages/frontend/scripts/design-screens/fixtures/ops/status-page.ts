/**
 * The public status page: its settings, the exposed services (grouped, one
 * degraded) and a recent incident history. Seeds 65000–65099.
 */
import type {
  StatusPageConfig,
  StatusPageIncident,
  StatusPageServiceItem,
  StatusPageSourceOption,
} from "@/types";
import { databases, pageProjects, routes } from "../catalog";
import { sslCertificates } from "../edge/ssl";
import { appsNode, edgeNode } from "../nodes";
import { ago, uuid } from "../time";

export const statusPageConfig: StatusPageConfig = {
  enabled: true,
  title: "Northwind Status",
  description: "Live availability of the Northwind storefront, API and customer tools.",
  domain: "status.example.com",
  nodeId: edgeNode.id,
  sslCertificateId: sslCertificates.find((cert) => cert.name === "status.example.com")?.id ?? null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: routes[3].id,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: "warning",
  autoOutageSeverity: "critical",
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 120,
};

type ServiceSpec = [
  seed: number,
  publicName: string,
  group: string,
  sourceType: StatusPageServiceItem["sourceType"],
  sourceId: string,
  label: string,
  status: StatusPageServiceItem["currentStatus"],
  description: string | null,
];

const SERVICES: ServiceSpec[] = [
  [
    1,
    "Storefront",
    "Customer experience",
    "proxy_host",
    routes[0].id,
    "app.example.com",
    "operational",
    "Web shop and checkout",
  ],
  [
    2,
    "Shop (EU)",
    "Customer experience",
    "proxy_host",
    routes[6].id,
    "shop.example.net",
    "operational",
    null,
  ],
  [
    3,
    "Public API",
    "Developers",
    "proxy_host",
    routes[1].id,
    "api.example.com",
    "operational",
    "REST API for partners and mobile apps",
  ],
  [
    4,
    "Documentation",
    "Developers",
    "pages_project",
    pageProjects[1].id,
    "docs-portal",
    "operational",
    null,
  ],
  [
    5,
    "Order processing",
    "Platform",
    "database",
    databases[0].id,
    "orders-db",
    "operational",
    "Order and payment records",
  ],
  [
    6,
    "Dashboards",
    "Platform",
    "proxy_host",
    routes[4].id,
    "grafana.example.com",
    "degraded",
    "Internal metrics dashboards",
  ],
  [
    7,
    "Background jobs",
    "Platform",
    "docker_deployment",
    uuid(65070),
    "worker on apps-1",
    "operational",
    "Invoices, exports and notifications",
  ],
];

export const statusPageServices: StatusPageServiceItem[] = SERVICES.map(
  ([seed, publicName, group, sourceType, sourceId, label, status, description], index) => ({
    id: uuid(65000 + seed),
    sourceType,
    sourceId,
    publicName,
    publicDescription: description,
    publicGroup: group,
    sortOrder: index,
    enabled: true,
    createThresholdSeconds: 600,
    resolveThresholdSeconds: 120,
    lastEvaluatedStatus: status,
    unhealthySince: status === "degraded" ? ago(38, "m") : null,
    healthySince: status === "operational" ? ago(2 + index, "d") : null,
    createdAt: ago(140 - index * 9, "d"),
    updatedAt: ago(10 + index, "d"),
    source: {
      label,
      status,
      rawStatus: status === "degraded" ? "degraded" : "online",
    },
    currentStatus: status,
    broken: false,
    sourceVisible: true,
  })
);

const service = (name: string) => statusPageServices.find((item) => item.publicName === name)!.id;

export const statusPageIncidents: StatusPageIncident[] = [
  {
    id: uuid(65031),
    title: "Dashboards responding slowly",
    message: "Dashboards has been degraded for more than 10 minutes.",
    severity: "warning",
    status: "active",
    type: "automatic",
    autoManaged: true,
    affectedServiceIds: [service("Dashboards")],
    startedAt: ago(28, "m"),
    resolvedAt: null,
    createdAt: ago(28, "m"),
    updatedAt: ago(9, "m"),
    updates: [
      {
        id: uuid(65041),
        status: "investigating",
        message: "Dashboards has been degraded for more than 10 minutes.",
        createdAt: ago(28, "m"),
      },
      {
        id: uuid(65042),
        status: "identified",
        message:
          "A long-running query on the metrics store is slowing panel loads. We are rebalancing it.",
        createdAt: ago(9, "m"),
      },
    ],
  },
  {
    id: uuid(65032),
    title: "Payment API errors",
    message: "Some checkout payments failed with a timeout.",
    severity: "critical",
    status: "resolved",
    type: "manual",
    autoManaged: false,
    affectedServiceIds: [service("Public API"), service("Storefront")],
    startedAt: ago(3, "d"),
    resolvedAt: ago(71, "h"),
    createdAt: ago(3, "d"),
    updatedAt: ago(71, "h"),
    updates: [
      {
        id: uuid(65043),
        status: "investigating",
        message: "Some checkout payments failed with a timeout.",
        createdAt: ago(72, "h"),
      },
      {
        id: uuid(65044),
        status: "identified",
        message:
          "The payment provider's EU endpoint answered slowly; requests now fail over to the secondary region.",
        createdAt: ago(71.6, "h"),
      },
      {
        id: uuid(65045),
        status: "monitoring",
        message: "Payments succeed again. We are watching error rates.",
        createdAt: ago(71.3, "h"),
      },
      {
        id: uuid(65046),
        status: "resolved",
        message: "The incident has been resolved and service is operating normally.",
        createdAt: ago(71, "h"),
      },
    ],
  },
  {
    id: uuid(65033),
    title: "Scheduled database maintenance",
    message: "Order processing moves to PostgreSQL 17. Orders placed during the window are queued.",
    severity: "info",
    status: "resolved",
    type: "manual",
    autoManaged: false,
    affectedServiceIds: [service("Order processing")],
    startedAt: ago(6, "d"),
    resolvedAt: ago(143, "h"),
    createdAt: ago(8, "d"),
    updatedAt: ago(143, "h"),
    updates: [
      {
        id: uuid(65047),
        status: "update",
        message:
          "Order processing moves to PostgreSQL 17. Orders placed during the window are queued.",
        createdAt: ago(6, "d"),
      },
      {
        id: uuid(65048),
        status: "resolved",
        message: "Maintenance finished; queued orders were processed.",
        createdAt: ago(143, "h"),
      },
    ],
  },
  {
    id: uuid(65034),
    title: "Background jobs delayed",
    message: "Background jobs has been in outage for more than 10 minutes.",
    severity: "critical",
    status: "resolved",
    type: "automatic",
    autoManaged: true,
    affectedServiceIds: [service("Background jobs")],
    startedAt: ago(11, "d"),
    resolvedAt: ago(263, "h"),
    createdAt: ago(11, "d"),
    updatedAt: ago(263, "h"),
    updates: [
      {
        id: uuid(65049),
        status: "investigating",
        message: "Background jobs has been in outage for more than 10 minutes.",
        createdAt: ago(11, "d"),
      },
      {
        id: uuid(65050),
        status: "resolved",
        message: "The incident has been resolved and service is operating normally.",
        createdAt: ago(263, "h"),
      },
    ],
  },
];

export const statusPageSources: StatusPageSourceOption[] = [
  {
    sourceType: "proxy_host",
    sourceId: routes[0].id,
    name: "app.example.com",
    nodeId: edgeNode.id,
    nodeName: "edge-fra-1",
  },
  {
    sourceType: "proxy_host",
    sourceId: routes[1].id,
    name: "api.example.com",
    nodeId: edgeNode.id,
    nodeName: "edge-fra-1",
  },
  {
    sourceType: "proxy_host",
    sourceId: routes[2].id,
    name: "auth.example.com",
    nodeId: edgeNode.id,
    nodeName: "edge-fra-1",
  },
  {
    sourceType: "database",
    sourceId: databases[0].id,
    name: "orders-db",
    nodeId: null,
    nodeName: null,
  },
  {
    sourceType: "docker_deployment",
    sourceId: uuid(65070),
    name: "worker",
    nodeId: appsNode.id,
    nodeName: "apps-1",
  },
  {
    sourceType: "pages_project",
    sourceId: pageProjects[0].id,
    name: "marketing-site",
    nodeId: null,
    nodeName: null,
  },
];
