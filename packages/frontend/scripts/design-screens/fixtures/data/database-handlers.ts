import { HttpResponse, http } from "msw";
import type { Node } from "@/types";
import { ok, wrapped } from "../../handlers";
import { nodes } from "../nodes";
import {
  emptyBrowse,
  ordersBackupPolicies,
  ordersBackupRuns,
  ordersBrowse,
  ordersNamespaces,
  ordersObjects,
} from "./database-tabs";
import {
  databaseById,
  databaseBySlug,
  databaseFolders,
  databaseRows,
  managedDatabaseCatalog,
  managedDatabases,
  ordersCertificate,
  ordersDb,
  ordersExtensions,
} from "./databases";

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

/** Database list, detail and the managed database endpoints behind them. */
export function databaseHandlers() {
  return [
    http.get("*/api/databases", ({ request }) => {
      const url = new URL(request.url);
      const search = url.searchParams.get("search")?.toLowerCase();
      const type = url.searchParams.get("type");
      const health = url.searchParams.get("healthStatus");
      const data = databaseRows.filter(
        (row) =>
          (!search || row.name.toLowerCase().includes(search)) &&
          (!type || row.type === type) &&
          (!health || row.healthStatus === health)
      );
      return ok({
        data,
        pagination: {
          page: 1,
          limit: Number(url.searchParams.get("limit") ?? 50),
          total: data.length,
          totalPages: 1,
        },
      });
    }),
    http.get("*/api/databases/folders", () => wrapped(databaseFolders)),
    http.get("*/api/databases/managed/catalog", () => wrapped(managedDatabaseCatalog)),
    http.get("*/api/databases/managed", () => wrapped(managedDatabases)),
    http.get("*/api/databases/managed/:id/certificate", ({ params }) =>
      params.id === ordersDb.managed!.id ? wrapped(ordersCertificate) : notFound()
    ),
    http.get("*/api/databases/managed/:id", ({ params }) => {
      const managed = managedDatabases.find((item) => item.id === params.id);
      return managed ? wrapped(managed) : notFound();
    }),
    http.get("*/api/databases/by-slug/:slug", ({ params }) => {
      const row = databaseBySlug(String(params.slug));
      return row ? wrapped(row) : notFound();
    }),
    http.get("*/api/databases/:id/health-history", ({ params }) => {
      const row = databaseById(String(params.id));
      return row ? wrapped(row.healthHistory ?? []) : notFound();
    }),
    http.get("*/api/databases/:id/postgres/extensions", ({ params }) =>
      params.id === ordersDb.id ? wrapped(ordersExtensions) : notFound()
    ),
    http.get("*/api/databases/:id", ({ params }) => {
      const row = databaseById(String(params.id));
      return row ? wrapped(row) : notFound();
    }),
  ];
}

/**
 * The managed database and storage hosts advertise the managed runtime and
 * backup capabilities, so pickers (create dialogs, backup executors) list them.
 */
export function managedNodeHandlers() {
  const capable: Node[] = nodes.map((node) =>
    node.type === "databases" || node.type === "storage"
      ? {
          ...node,
          capabilities: {
            managedDatabasesV1: true,
            managedStorageV1: true,
            databaseBackupsV1: true,
          },
        }
      : node
  );
  return [
    http.get("*/api/nodes", ({ request }) => {
      const type = new URL(request.url).searchParams.get("type");
      const data = capable.filter((node) => !type || type === "all" || node.type === type);
      return ok({ data, total: data.length, page: 1, limit: 100, totalPages: 1 });
    }),
  ];
}

/** Explorer, backups and logs behind the orders-db tabs. */
export function databaseTabHandlers() {
  return [
    http.get("*/api/databases/:id/sql/namespaces", ({ params }) =>
      params.id === ordersDb.id ? wrapped(ordersNamespaces) : notFound()
    ),
    http.get("*/api/databases/:id/sql/objects", ({ params, request }) => {
      if (params.id !== ordersDb.id) return notFound();
      const namespace = new URL(request.url).searchParams.get("namespace") ?? "public";
      return wrapped(ordersObjects[namespace] ?? []);
    }),
    http.get("*/api/databases/:id/sql/rows", ({ params, request }) => {
      if (params.id !== ordersDb.id) return notFound();
      const url = new URL(request.url);
      const namespace = url.searchParams.get("namespace") ?? "public";
      const table = url.searchParams.get("table") ?? "orders";
      return wrapped(
        namespace === "public" && table === "orders" ? ordersBrowse : emptyBrowse(namespace, table)
      );
    }),
    http.get("*/api/databases/:id/backups/policies", ({ params }) =>
      wrapped(params.id === ordersDb.id ? ordersBackupPolicies : [])
    ),
    http.get("*/api/databases/:id/backups/runs", ({ params }) =>
      wrapped(params.id === ordersDb.id ? ordersBackupRuns : [])
    ),
  ];
}
