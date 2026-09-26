import { HttpResponse, http } from "msw";
import type { FolderTreeNode, ProxyHost } from "@/types";
import { ok, wrapped } from "../../handlers";
import {
  accessLists,
  appAdditionalRoutes,
  appRoute,
  appSecureLinks,
  certificates,
  dockerSnapshotNodes,
  dockerSnapshotRows,
  folderTree,
  healthHistories,
  nginxTemplates,
  proxyHostById,
  proxyHostBySlug,
  proxyHosts,
  registeredDomains,
} from "./data";

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

function paginated<T>(data: T[], url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
  const page = Number(url.searchParams.get("page") ?? 1) || 1;
  const rows = data.slice((page - 1) * limit, page * limit);
  return ok({
    data: rows,
    pagination: { page, limit, total: data.length, totalPages: Math.max(1, Math.ceil(data.length / limit)) },
  });
}

/** The filters `GET /proxy-host-folders/grouped` and `GET /proxy-hosts` accept. */
function matchesFilters(host: ProxyHost, url: URL) {
  const search = url.searchParams.get("search")?.trim().toLowerCase();
  const type = url.searchParams.get("type");
  const health = url.searchParams.get("healthStatus");
  const enabled = url.searchParams.get("enabled");
  if (search && !host.domainNames.some((domain) => domain.toLowerCase().includes(search))) return false;
  if (type && host.type !== type) return false;
  if (health && (host.effectiveHealthStatus ?? host.healthStatus) !== health) return false;
  if (enabled !== null && String(host.enabled) !== enabled) return false;
  return true;
}

function filterTree(tree: FolderTreeNode[], keep: (host: ProxyHost) => boolean): FolderTreeNode[] {
  return tree.map((folder) => ({
    ...folder,
    hosts: folder.hosts.filter(keep),
    children: filterTree(folder.children, keep),
  }));
}

export interface RouteHandlerOptions {
  /** Answer for `POST /api/proxy-hosts`; defaults to never resolving. */
  createRoute?: () => Response | Promise<Response>;
}

/** Everything the routes list, route detail and Create Route dialog read. */
export function routeHandlers(options: RouteHandlerOptions = {}) {
  return [
    // Routes list (folders view)
    http.get("*/api/proxy-host-folders/grouped", ({ request }) => {
      const url = new URL(request.url);
      const keep = (host: ProxyHost) => matchesFilters(host, url);
      const folders = filterTree(folderTree, keep);
      const ungroupedHosts = proxyHosts.filter((host) => !host.folderId && keep(host));
      const totalHosts =
        ungroupedHosts.length + folders.reduce((sum, folder) => sum + folder.hosts.length, 0);
      return wrapped({ folders, ungroupedHosts, totalHosts });
    }),
    http.get("*/api/proxy-host-folders", () => wrapped(folderTree)),
    http.get("*/api/proxy-hosts", ({ request }) => {
      const url = new URL(request.url);
      return paginated(
        proxyHosts.filter((host) => matchesFilters(host, url)),
        url
      );
    }),

    // Route detail
    http.get("*/api/proxy-hosts/by-slug/:slug", ({ params }) => {
      const host = proxyHostBySlug(String(params.slug));
      return host ? wrapped(host) : notFound();
    }),
    http.get("*/api/proxy-hosts/:id/health-history", ({ params }) => {
      const host = proxyHostById(String(params.id));
      return host ? wrapped(healthHistories[host.slug] ?? []) : notFound();
    }),
    http.get("*/api/proxy-hosts/:id/additional-routes", ({ params }) =>
      wrapped(String(params.id) === appRoute.id ? appAdditionalRoutes : [])
    ),
    http.get("*/api/proxy-hosts/:id/additional-secure-links", ({ params }) =>
      wrapped(String(params.id) === appRoute.id ? appSecureLinks : [])
    ),
    http.get("*/api/proxy-hosts/:id", ({ params }) => {
      const host = proxyHostById(String(params.id));
      return host ? wrapped(host) : notFound();
    }),
    http.post("*/api/proxy-hosts", () =>
      options.createRoute ? options.createRoute() : new Promise<Response>(() => {})
    ),

    // Option lists for the settings tab and the create dialog
    http.get("*/api/ssl-certificates", ({ request }) =>
      paginated(certificates, new URL(request.url))
    ),
    http.get("*/api/access-lists", ({ request }) => paginated(accessLists, new URL(request.url))),
    http.get("*/api/nginx-templates", () => wrapped(nginxTemplates)),
    http.get("*/api/docker/containers", () =>
      ok({
        data: dockerSnapshotRows,
        total: dockerSnapshotRows.length,
        limit: 500,
        truncated: false,
        nodes: dockerSnapshotNodes,
      })
    ),
    http.get("*/api/docker/compose-projects", () => wrapped([])),
    http.get("*/api/domains/search", ({ request }) => {
      const query = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
      return wrapped(registeredDomains.filter((domain) => domain.domain.includes(query)));
    }),
  ];
}
