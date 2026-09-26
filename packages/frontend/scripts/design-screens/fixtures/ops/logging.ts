/**
 * Structured logging: environments, the shared schema and a recent slice of
 * production events from the web, api and worker services. Seeds 64200–64399.
 */
import type {
  LoggingEnvironment,
  LoggingFieldDefinition,
  LoggingMetadata,
  LoggingSchema,
  LoggingSearchResult,
  LoggingSeverity,
} from "@/types";
import { agoMs, ago, uuid } from "../time";

const serviceFields: LoggingFieldDefinition[] = [
  { key: "region", location: "label", type: "string", required: true, description: "Deployment region" },
  { key: "version", location: "label", type: "string", required: true, description: "Release tag" },
  { key: "statusCode", location: "field", type: "number", required: false },
  { key: "durationMs", location: "field", type: "number", required: false },
  { key: "route", location: "field", type: "string", required: false },
  { key: "jobId", location: "field", type: "string", required: false },
];

export const loggingSchemas: LoggingSchema[] = [
  {
    id: uuid(64201),
    name: "Service events",
    slug: "service-events",
    description: "Shared shape for Northwind application services",
    schemaMode: "strip",
    fieldSchema: serviceFields,
    folderId: null,
    sortOrder: 0,
    createdById: "user-maya",
    createdAt: ago(160, "d"),
    updatedAt: ago(21, "d"),
  },
  {
    id: uuid(64202),
    name: "Edge access",
    slug: "edge-access",
    description: "Access log fields forwarded from edge nodes",
    schemaMode: "loose",
    fieldSchema: [
      { key: "node", location: "label", type: "string", required: true },
      { key: "statusCode", location: "field", type: "number", required: true },
      { key: "bytesSent", location: "field", type: "number", required: false },
    ],
    folderId: null,
    sortOrder: 1,
    createdById: "user-omar",
    createdAt: ago(98, "d"),
    updatedAt: ago(98, "d"),
  },
];

function environment(
  seed: number,
  overrides: Partial<LoggingEnvironment> & Pick<LoggingEnvironment, "name" | "slug">
): LoggingEnvironment {
  return {
    id: uuid(64210 + seed),
    description: null,
    enabled: true,
    schemaId: loggingSchemas[0].id,
    schemaName: loggingSchemas[0].name,
    schemaMode: "strip",
    retentionDays: 30,
    rateLimitRequestsPerWindow: null,
    rateLimitEventsPerWindow: null,
    fieldSchema: serviceFields,
    folderId: null,
    sortOrder: seed,
    createdById: "user-maya",
    createdAt: ago(150 - seed * 20, "d"),
    updatedAt: ago(9 + seed, "d"),
    ...overrides,
  };
}

export const loggingEnvironments: LoggingEnvironment[] = [
  environment(0, {
    name: "Production",
    slug: "production",
    description: "Customer-facing web, api and worker services",
    retentionDays: 30,
    rateLimitRequestsPerWindow: 600,
    rateLimitEventsPerWindow: 60_000,
  }),
  environment(1, {
    name: "Staging",
    slug: "staging",
    description: "Pre-release builds of the same services",
    retentionDays: 7,
  }),
  environment(2, {
    name: "Edge access",
    slug: "edge-access",
    description: "Access logs from edge-fra-1 and edge-ams-1",
    schemaId: loggingSchemas[1].id,
    schemaName: loggingSchemas[1].name,
    schemaMode: "loose",
    fieldSchema: loggingSchemas[1].fieldSchema,
    retentionDays: 14,
  }),
];

export const productionEnvironment = loggingEnvironments[0];

export const loggingMetadata: LoggingMetadata = {
  services: ["api", "web", "worker"],
  sources: ["apps-1", "apps-2"],
  labelKeys: ["region", "version"],
  fieldKeys: ["statusCode", "durationMs", "route", "jobId", "orderId", "queue"],
  labelValues: {
    region: ["eu-central", "eu-west"],
    version: ["2.8.1"],
  },
};

type EventSpec = [
  seconds: number,
  severity: LoggingSeverity,
  service: "web" | "api" | "worker",
  message: string,
  fields: Record<string, unknown>,
];

// Newest first, as the search endpoint returns them.
const EVENTS: EventSpec[] = [
  [8, "info", "api", "POST /v1/orders 201 in 84 ms", { route: "/v1/orders", statusCode: 201, durationMs: 84 }],
  [14, "info", "web", "GET /checkout 200 in 41 ms", { route: "/checkout", statusCode: 200, durationMs: 41 }],
  [22, "debug", "worker", "Picked job invoices.render (queue=default, attempt 1)", { jobId: "job_7f3a91", queue: "default" }],
  [37, "warn", "api", "Slow query orders_by_customer took 1840 ms", { route: "/v1/customers/:id/orders", durationMs: 1840 }],
  [51, "info", "worker", "Sent order confirmation to customer 48213", { jobId: "job_7f3a8c", orderId: "ord_48213" }],
  [66, "error", "worker", "Payment capture failed for ord_48207: card_declined", { jobId: "job_7f3a77", orderId: "ord_48207", statusCode: 402 }],
  [79, "info", "api", "GET /v1/catalog/items 200 in 23 ms", { route: "/v1/catalog/items", statusCode: 200, durationMs: 23 }],
  [95, "info", "web", "GET / 200 in 12 ms", { route: "/", statusCode: 200, durationMs: 12 }],
  [118, "warn", "web", "Upstream api answered 429, retrying in 250 ms", { route: "/cart", statusCode: 429 }],
  [142, "info", "api", "Session refreshed for customer 48213", { route: "/v1/auth/refresh", statusCode: 200, durationMs: 18 }],
  [171, "debug", "api", "Cache miss catalog:featured, rebuilt in 96 ms", { durationMs: 96 }],
  [204, "info", "worker", "Nightly export orders-2026-09 uploaded to assets", { jobId: "job_7f3a02", queue: "exports" }],
  [236, "error", "api", "Unhandled TimeoutError on POST /v1/payments after 10000 ms", { route: "/v1/payments", statusCode: 504, durationMs: 10_000 }],
  [263, "info", "web", "GET /account/orders 200 in 58 ms", { route: "/account/orders", statusCode: 200, durationMs: 58 }],
  [301, "warn", "worker", "Retrying webhook delivery to fulfillment (attempt 2 of 5)", { jobId: "job_7f39e5", statusCode: 503 }],
];

const hex = (seed: number, length: number) => uuid(seed).replace(/-/g, "").slice(0, length);

export const loggingEvents: LoggingSearchResult[] = EVENTS.map(
  ([seconds, severity, service, message, fields], index) => ({
    eventId: uuid(64300 + index),
    timestamp: new Date(agoMs(seconds, "s")).toISOString(),
    ingestedAt: new Date(agoMs(seconds - 1, "s")).toISOString(),
    environmentId: productionEnvironment.id,
    severity,
    message,
    service,
    source: index % 3 === 2 ? "apps-2" : "apps-1",
    traceId: hex(64330 + index, 32),
    spanId: hex(64360 + index, 16),
    requestId: `req_${hex(64390 - index, 12)}`,
    labels: { region: index % 4 === 3 ? "eu-west" : "eu-central", version: "2.8.1" },
    fields,
  })
);
