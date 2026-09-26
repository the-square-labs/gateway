import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
import { dockerNodes, nodes } from "../nodes";
import {
  composeSummaries,
  containerFolders,
  containerRows,
  imageRows,
  networkRows,
  registries,
  snapshotEnvelope,
  tasks,
  volumeRows,
} from "./data";

const includes = (values: Array<string | undefined | null>, query: string) =>
  values.some((value) => value?.toLowerCase().includes(query));

/**
 * Docker list endpoints: the snapshot lists, folders, tasks, Compose projects and
 * registries the Docker page and the shell's background prefetch ask for.
 */
export function dockerListHandlers() {
  return [
    http.get("*/api/docker/containers", ({ request }) =>
      ok(
        snapshotEnvelope(containerRows, new URL(request.url).searchParams, (row, q) =>
          includes([row.name, row.image, row.id, row.state, row.status], q)
        )
      )
    ),
    http.get("*/api/docker/images", ({ request }) =>
      ok(
        snapshotEnvelope(imageRows, new URL(request.url).searchParams, (row, q) =>
          includes([row.id, ...row.repoTags], q)
        )
      )
    ),
    http.get("*/api/docker/volumes", ({ request }) =>
      ok(
        snapshotEnvelope(volumeRows, new URL(request.url).searchParams, (row, q) =>
          includes([row.name, row.driver, ...(row.usedBy ?? [])], q)
        )
      )
    ),
    http.get("*/api/docker/networks", ({ request }) =>
      ok(
        snapshotEnvelope(networkRows, new URL(request.url).searchParams, (row, q) =>
          includes([row.id, row.name, row.driver], q)
        )
      )
    ),
    http.get("*/api/docker/folders", ({ request }) => {
      const type = new URL(request.url).searchParams.get("resourceType") ?? "container";
      return wrapped(type === "container" ? containerFolders : []);
    }),
    // No folder placements for images, volumes, networks or Compose projects.
    http.post("*/api/docker/folders/placements", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        items?: Array<{ nodeId: string; resourceKey: string }>;
      };
      return wrapped(
        (body.items ?? []).map((item, index) => ({
          ...item,
          folderId: null,
          folderIsSystem: false,
          sortOrder: index,
        }))
      );
    }),
    http.get("*/api/docker/tasks", ({ request }) => {
      const nodeId = new URL(request.url).searchParams.get("nodeId");
      return wrapped(tasks.filter((task) => !nodeId || task.nodeId === nodeId));
    }),
    http.get("*/api/docker/compose-projects", ({ request }) => {
      const nodeId = new URL(request.url).searchParams.get("nodeId");
      return wrapped(composeSummaries.filter((project) => !nodeId || project.nodeId === nodeId));
    }),
    http.get("*/api/docker/registries", () => wrapped(registries)),
    http.post("*/api/docker/snapshots/refresh", () => wrapped({ accepted: true })),
    http.get("*/api/docker/nodes/by-slug/:slug", ({ params }) => {
      const node = dockerNodes.find((item) => item.slug === params.slug);
      if (!node) return HttpResponse.json({ message: "Not found" }, { status: 404 });
      return wrapped({
        id: node.id,
        slug: node.slug,
        type: node.type,
        hostname: node.hostname,
        displayName: node.displayName,
        appearanceColor: node.appearanceColor,
      });
    }),
    // Per-node image lists (deploy dialog image picker).
    http.get("*/api/docker/nodes/:nodeId/images", ({ params }) => {
      const data = imageRows.filter((row) => row.nodeId === params.nodeId);
      return ok({ data, total: data.length, limit: 1000, truncated: false });
    }),
  ];
}

/**
 * The Docker nodes advertise the Compose capability (both run Compose projects), so
 * the Compose create dialog offers them as targets.
 */
export function composeCapableNodeHandlers() {
  return [
    http.get("*/api/nodes", ({ request }) => {
      const type = new URL(request.url).searchParams.get("type");
      const data = nodes
        .filter((node) => !type || type === "all" || node.type === type)
        .map((node) =>
          node.type === "docker"
            ? { ...node, capabilities: { ...node.capabilities, dockerComposeV1: true } }
            : node
        );
      return ok({ data, total: data.length, page: 1, limit: 50, totalPages: 1 });
    }),
  ];
}
