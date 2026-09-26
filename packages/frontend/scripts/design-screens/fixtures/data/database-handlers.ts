import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
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
        pagination: { page: 1, limit: Number(url.searchParams.get("limit") ?? 50), total: data.length, totalPages: 1 },
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
