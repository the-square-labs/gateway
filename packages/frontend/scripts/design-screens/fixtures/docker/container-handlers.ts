import { HttpResponse, http } from "msw";
import { wrapped } from "../../handlers";
import { apps1 } from "./data";
import { webContainerId, webHealthCheck, webInspect } from "./container-detail";

export function dockerContainerDetailHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  return [
    // An image-based container: no Git source binding.
    http.get("*/api/docker/nodes/:nodeId/containers/:name/source", () => wrapped(null)),
    http.get("*/api/docker/nodes/:nodeId/containers/:name/health-check", ({ params }) =>
      params.nodeId === apps1.id && params.name === "web" ? wrapped(webHealthCheck) : notFound()
    ),
    // Single-node workload: no availability policy.
    http.get("*/api/docker/availability/by-resource", () => wrapped(null)),
    http.get("*/api/docker/nodes/:nodeId/containers/by-name/:name", ({ params }) =>
      params.nodeId === apps1.id && params.name === "web" ? wrapped(webInspect) : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId", ({ params }) =>
      params.nodeId === apps1.id && params.containerId === webContainerId
        ? wrapped(webInspect)
        : notFound()
    ),
  ];
}
