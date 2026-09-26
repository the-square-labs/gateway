import { HttpResponse, http } from "msw";
import type { PageProject } from "@/types";
import { ok, wrapped } from "../../handlers";
import {
  marketingDeployments,
  marketingProject,
  marketingTags,
  pageProjectRows,
  pagesPlacementOptions,
} from "./pages";

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

function page<T>(data: T[], request: Request) {
  const url = new URL(request.url);
  return ok({
    data,
    pagination: {
      page: 1,
      limit: Number(url.searchParams.get("limit") ?? 50),
      total: data.length,
      totalPages: data.length ? 1 : 0,
    },
  });
}

/** Pages projects, deployments and tags; `projects` lets a screen show an empty installation. */
export function pagesHandlers({ projects = pageProjectRows }: { projects?: PageProject[] } = {}) {
  const byId = (id: string) => projects.find((project) => project.id === id);
  return [
    http.get("*/api/pages", ({ request }) => page(projects, request)),
    http.get("*/api/pages/folders", () => wrapped([])),
    http.get("*/api/pages/placement-options", () => wrapped(pagesPlacementOptions)),
    http.get("*/api/pages/by-slug/:slug", ({ params }) => {
      const project = projects.find((item) => item.slug === params.slug);
      return project ? wrapped(project) : notFound();
    }),
    http.get("*/api/pages/:id/deployments", ({ params, request }) =>
      params.id === marketingProject.id && byId(marketingProject.id)
        ? page(marketingDeployments, request)
        : page([], request)
    ),
    http.get("*/api/pages/:id/tags", ({ params }) =>
      wrapped(params.id === marketingProject.id ? marketingTags : [])
    ),
    http.get("*/api/pages/:id", ({ params }) => {
      const project = byId(String(params.id));
      return project ? wrapped(project) : notFound();
    }),
  ];
}
