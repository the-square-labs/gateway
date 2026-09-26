/**
 * Content behind the orders-db tabs: the SQL explorer catalog and rows, backup
 * policies and history, and the container log tail. Seeds 3200–3299.
 */
import type {
  SqlBrowseResult,
  SqlColumnMetadata,
  SqlNamespace,
  SqlObjectSummary,
  SqlTableMetadata,
} from "@/types";
import type { BackupPolicy, BackupRun } from "@/types/backups";
import { nodeBySlug } from "../nodes";
import { ago, agoMs, uuid } from "../time";
import { ordersDb } from "./databases";
import { backupsStorage } from "./storage";

const MiB = 1024 ** 2;
const dbNode = nodeBySlug("db-1")!;
const storageNode = nodeBySlug("storage-1")!;

export const ordersNamespaces: SqlNamespace[] = [
  { name: "public", system: false },
  { name: "billing", system: false },
  { name: "reporting", system: false },
  { name: "information_schema", system: true },
  { name: "pg_catalog", system: true },
];

export const ordersObjects: Record<string, SqlObjectSummary[]> = {
  public: [
    { name: "orders", type: "table", estimatedRows: 48_213, estimatedBytes: 38 * MiB },
    { name: "order_items", type: "table", estimatedRows: 131_904, estimatedBytes: 71 * MiB },
    { name: "customers", type: "table", estimatedRows: 17_480, estimatedBytes: 9 * MiB },
    { name: "payments", type: "table", estimatedRows: 47_992, estimatedBytes: 22 * MiB },
    { name: "shipments", type: "table", estimatedRows: 45_117, estimatedBytes: 18 * MiB },
    { name: "products", type: "table", estimatedRows: 1_284, estimatedBytes: 2 * MiB },
    { name: "open_orders", type: "view", estimatedRows: null, estimatedBytes: null },
  ],
  billing: [
    { name: "invoices", type: "table", estimatedRows: 46_870, estimatedBytes: 26 * MiB },
    { name: "refunds", type: "table", estimatedRows: 912, estimatedBytes: 1 * MiB },
  ],
  reporting: [
    {
      name: "daily_revenue",
      type: "materialized-view",
      estimatedRows: 730,
      estimatedBytes: 1 * MiB,
    },
  ],
};

function column(
  name: string,
  dataType: string,
  extra: Partial<SqlColumnMetadata> = {}
): SqlColumnMetadata {
  return { name, dataType, nullable: false, isPrimaryKey: false, hasDefault: false, ...extra };
}

const ordersMetadata: SqlTableMetadata = {
  provider: "postgres",
  namespace: "public",
  table: "orders",
  objectType: "table",
  columns: [
    column("id", "bigint", {
      isPrimaryKey: true,
      hasDefault: true,
      defaultExpression: "nextval('orders_id_seq'::regclass)",
    }),
    column("number", "text"),
    column("customer_email", "text"),
    column("status", "text", { hasDefault: true, defaultExpression: "'pending'::text" }),
    column("total", "numeric(12,2)"),
    column("currency", "character(3)", { hasDefault: true, defaultExpression: "'EUR'::bpchar" }),
    column("placed_at", "timestamp with time zone", {
      hasDefault: true,
      defaultExpression: "now()",
    }),
    column("shipped_at", "timestamp with time zone", { nullable: true }),
  ],
  primaryKey: ["id"],
  hasPrimaryKey: true,
  mutations: {
    rowInsert: true,
    rowUpdate: true,
    rowDelete: true,
    identityColumns: ["id"],
    immutableColumns: [],
  },
};

const ORDER_ROWS: Array<[number, string, string, string, string, number, number | null]> = [
  [48213, "NW-48213", "ines.moreau@example.com", "paid", "184.90", 6, null],
  [48212, "NW-48212", "tomas.berg@example.net", "shipped", "62.40", 47, 20],
  [48211, "NW-48211", "akira.sato@example.com", "shipped", "129.00", 95, 61],
  [48210, "NW-48210", "lucia.ferri@example.org", "pending", "38.50", 132, null],
  [48209, "NW-48209", "noah.keller@example.com", "delivered", "412.75", 210, 184],
  [48208, "NW-48208", "zara.okafor@example.net", "delivered", "74.20", 305, 260],
  [48207, "NW-48207", "felix.wagner@example.com", "payment_failed", "219.99", 344, null],
  [48206, "NW-48206", "maria.silva@example.org", "delivered", "96.10", 402, 351],
];

export const ordersBrowse: SqlBrowseResult = {
  metadata: ordersMetadata,
  rows: ORDER_ROWS.map(([id, number, email, status, total, placedMin, shippedMin]) => ({
    id,
    number,
    customer_email: email,
    status,
    total,
    currency: "EUR",
    placed_at: new Date(agoMs(placedMin, "m")).toISOString(),
    shipped_at: shippedMin === null ? null : new Date(agoMs(shippedMin, "m")).toISOString(),
  })),
  page: 1,
  limit: 100,
  // Postgres reports the planner's estimate for large tables, so the grid stops at one page.
  total: 48_213,
  totalKind: "approximate",
  truncated: false,
};

/** An empty page with the right columns for tables the screens do not open. */
export function emptyBrowse(namespace: string, table: string): SqlBrowseResult {
  return {
    ...ordersBrowse,
    metadata: { ...ordersMetadata, namespace, table },
    rows: [],
    total: 0,
  };
}

export const ordersBackupPolicies: BackupPolicy[] = [
  {
    id: uuid(3201),
    databaseConnectionId: ordersDb.id,
    destinationId: backupsStorage.id,
    bucket: "db-backups",
    prefix: "orders-db/nightly",
    stagingStorageConnectionId: null,
    stagingBucket: null,
    executorNodeId: storageNode.id,
    schedule: "0 2 * * *",
    timezone: "Europe/Berlin",
    retentionCount: 14,
    limits: { workspaceBytes: 20 * 1024 * MiB, timeoutSeconds: 3600, cpuCores: 2, memoryMb: 2048 },
    enabled: true,
    lastError: null,
    lastErrorAt: null,
  },
  {
    id: uuid(3202),
    databaseConnectionId: ordersDb.id,
    destinationId: backupsStorage.id,
    bucket: "db-backups",
    prefix: "orders-db/pre-release",
    stagingStorageConnectionId: null,
    stagingBucket: null,
    executorNodeId: dbNode.id,
    schedule: null,
    timezone: "UTC",
    retentionCount: 5,
    limits: { workspaceBytes: 20 * 1024 * MiB, timeoutSeconds: 3600, cpuCores: 2, memoryMb: 2048 },
    enabled: true,
    lastError: null,
    lastErrorAt: null,
  },
];

function run(seed: number, daysAgo: number, overrides: Partial<BackupRun> = {}): BackupRun {
  const startedAt = ago(daysAgo * 24 - 2, "h");
  return {
    id: uuid(3210 + seed),
    policyId: ordersBackupPolicies[0].id,
    databaseConnectionId: ordersDb.id,
    databaseConnectionName: ordersDb.name,
    destinationId: backupsStorage.id,
    destinationBucket: "db-backups",
    destinationPrefix: "orders-db/nightly",
    stagingStorageConnectionId: null,
    stagingBucket: null,
    timezone: "Europe/Berlin",
    executorNodeId: storageNode.id,
    direction: "backup",
    engine: "postgres",
    status: "completed",
    phase: "completed",
    bytes: String(Math.round((1_412 + seed * 9) * MiB)),
    manifest: null,
    error: null,
    startedAt,
    completedAt: ago(daysAgo * 24 - 2.1, "h"),
    artifactsDeletedAt: null,
    createdAt: startedAt,
    ...overrides,
  };
}

export const ordersBackupRuns: BackupRun[] = [
  run(1, 0.3),
  run(2, 1),
  run(3, 1.4, {
    policyId: ordersBackupPolicies[1].id,
    executorNodeId: dbNode.id,
    destinationPrefix: "orders-db/pre-release",
    timezone: "UTC",
  }),
  run(4, 2, {
    status: "failed",
    phase: "uploading",
    bytes: "0",
    error: "Upload to db-backups timed out after 3600 s (storage-1 was restarting)",
  }),
  run(5, 3),
  run(6, 4, { direction: "restore", phase: "completed", bytes: String(1_371 * MiB) }),
  run(7, 5),
  run(8, 16, { artifactsDeletedAt: ago(2, "d") }),
];

/** The container log tail of the managed Postgres runtime, oldest first. */
export function ordersLogLines(): string[] {
  const lines: Array<[number, string]> = [
    [3_420, "LOG:  checkpoint starting: time"],
    [
      3_388,
      "LOG:  checkpoint complete: wrote 1843 buffers (11.2%); 0 WAL file(s) added, 0 removed, 1 recycled; write=184.312 s, sync=0.021 s, total=184.380 s",
    ],
    [2_705, "LOG:  connection received: host=10.0.12.4 port=51842"],
    [
      2_705,
      "LOG:  connection authorized: user=orders_app database=orders SSL enabled (protocol=TLSv1.3, cipher=TLS_AES_256_GCM_SHA384)",
    ],
    [2_190, 'LOG:  automatic vacuum of table "orders.public.order_items": index scans: 1'],
    [2_190, "\tpages: 0 removed, 9124 remain, 1206 scanned (13.22% of total)"],
    [1_830, "LOG:  checkpoint starting: time"],
    [
      1_642,
      "LOG:  checkpoint complete: wrote 1219 buffers (7.4%); 0 WAL file(s) added, 0 removed, 1 recycled; write=121.904 s, sync=0.017 s, total=121.960 s",
    ],
    [
      1_104,
      "LOG:  duration: 1840.317 ms  statement: SELECT o.* FROM orders o WHERE o.customer_email = $1 ORDER BY placed_at DESC",
    ],
    [980, "LOG:  connection received: host=10.0.12.5 port=40216"],
    [
      980,
      "LOG:  connection authorized: user=orders_app database=orders SSL enabled (protocol=TLSv1.3, cipher=TLS_AES_256_GCM_SHA384)",
    ],
    [612, "WARNING:  terminating connection because of idle-in-transaction timeout"],
    [240, "LOG:  checkpoint starting: time"],
    [
      61,
      "LOG:  checkpoint complete: wrote 402 buffers (2.5%); 0 WAL file(s) added, 0 removed, 0 recycled; write=40.221 s, sync=0.009 s, total=40.260 s",
    ],
    [12, "LOG:  connection received: host=10.0.12.4 port=51990"],
  ];
  return lines.map(([seconds, text]) => {
    const timestamp = new Date(agoMs(seconds, "s")).toISOString().replace("Z", "000000Z");
    return `${timestamp} ${new Date(agoMs(seconds, "s")).toISOString().replace("T", " ").slice(0, 23)} UTC [1] ${text}`;
  });
}
