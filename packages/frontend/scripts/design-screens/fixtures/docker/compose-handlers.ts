import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
import { composeIds, stackOperations, stackProject, stackRevisions } from "./data";

/** Detail endpoints of the `northwind-stack` Compose project on apps-2. */
export function dockerComposeDetailHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  const isStack = (params: Record<string, unknown>) =>
    params.nodeId === stackProject.nodeId && params.projectId === composeIds.stack;
  return [
    http.get("*/api/docker/nodes/:nodeId/compose-projects/:projectId/operations", ({ params, request }) => {
      if (!isStack(params)) return notFound();
      const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
      return ok({ data: stackOperations.slice(0, limit), nextCursor: null });
    }),
    http.get("*/api/docker/nodes/:nodeId/compose-projects/:projectId/revisions", ({ params }) =>
      isStack(params) ? wrapped(stackRevisions) : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/compose-projects/:projectId/secrets", ({ params }) =>
      isStack(params)
        ? wrapped([
            {
              id: "secret-database-url",
              key: "DATABASE_URL",
              value: "••••••••",
              createdAt: stackRevisions[1].createdAt,
              updatedAt: stackRevisions[1].createdAt,
            },
          ])
        : notFound()
    ),
    // Deployed from YAML, not from a Git source.
    http.get("*/api/docker/nodes/:nodeId/compose-projects/:projectId/source", () => wrapped(null)),
    http.get("*/api/docker/nodes/:nodeId/compose-projects/:projectId", ({ params }) =>
      isStack(params) ? wrapped(stackProject) : notFound()
    ),
    // Single-node project: no availability policy.
    http.get("*/api/docker/availability/by-resource", () => wrapped(null)),
  ];
}
