import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
import {
  managedStorageCatalog,
  managedStorages,
  storageFolders,
  storageRows,
} from "./storage";

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

/** Storage list and the managed storage endpoints behind it. */
export function storageHandlers() {
  return [
    http.get("*/api/object-storage", ({ request }) => {
      const url = new URL(request.url);
      const search = url.searchParams.get("search")?.toLowerCase();
      const provider = url.searchParams.get("provider");
      const health = url.searchParams.get("healthStatus");
      const data = storageRows.filter(
        (row) =>
          (!search || row.name.toLowerCase().includes(search)) &&
          (!provider || row.provider === provider) &&
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
    http.get("*/api/object-storage/folders", () => wrapped(storageFolders)),
    http.get("*/api/object-storage/:id", ({ params }) => {
      const row = storageRows.find((item) => item.id === params.id);
      return row ? wrapped(row) : notFound();
    }),
    http.get("*/api/managed-storage/catalog", () => wrapped(managedStorageCatalog)),
    http.get("*/api/managed-storage", () => wrapped(managedStorages)),
  ];
}
