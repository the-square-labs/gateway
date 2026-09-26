import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
import { systemConfig } from "../shell";
import { managedStorageCatalog, managedStorages, storageFolders, storageRows } from "./storage";
import {
  backupsAccessKeys,
  backupsBuckets,
  backupsCertificate,
  backupsHealthHistory,
  backupsListing,
  backupsReadme,
} from "./storage-detail";

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

/** Detail, health, certificate, buckets, objects and IAM keys of a storage connection. */
export function storageDetailHandlers() {
  return [
    http.get("*/api/object-storage/by-slug/:slug", ({ params }) => {
      const row = storageRows.find((item) => item.slug === params.slug);
      return row ? wrapped(row) : notFound();
    }),
    http.get("*/api/object-storage/:id/health-history", ({ params }) => {
      const row = storageRows.find((item) => item.id === params.id);
      if (!row) return notFound();
      return wrapped(row.managed ? backupsHealthHistory : (row.healthHistory ?? []));
    }),
    // Upload and open limits of the file manager.
    http.get("*/api/system/config", () => wrapped(systemConfig)),
    http.get("*/api/object-storage/:id/buckets", () => wrapped(backupsBuckets)),
    http.get("*/api/object-storage/:id/objects/download", ({ request }) => {
      const key = new URL(request.url).searchParams.get("key") ?? "";
      return key.endsWith("README.md")
        ? new HttpResponse(backupsReadme, { headers: { "Content-Type": "text/markdown" } })
        : notFound();
    }),
    http.get("*/api/object-storage/:id/objects", ({ request }) => {
      const url = new URL(request.url);
      return wrapped(
        backupsListing(url.searchParams.get("bucket") ?? "", url.searchParams.get("prefix") ?? "")
      );
    }),
    http.get("*/api/managed-storage/:id/certificate", ({ params }) =>
      params.id === backupsCertificate.ownerId ? wrapped(backupsCertificate) : notFound()
    ),
    http.get("*/api/managed-storage/:id/iam-keys", () => wrapped(backupsAccessKeys)),
    http.get("*/api/managed-storage/:id", ({ params }) => {
      const managed = managedStorages.find((item) => item.id === params.id);
      return managed ? wrapped(managed) : notFound();
    }),
  ];
}
