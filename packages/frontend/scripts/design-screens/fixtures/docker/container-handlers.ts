import { HttpResponse, http } from "msw";
import { wrapped } from "../../handlers";
import { webSource } from "./builds";
import { webContainerId, webHealthCheck, webInspect } from "./container-detail";
import { apps1 } from "./data";

export function dockerContainerDetailHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  return [
    // Built from Git (northwind/web on the Northwind GitLab connector).
    http.get("*/api/docker/nodes/:nodeId/containers/:name/source", ({ params }) =>
      params.nodeId === apps1.id && params.name === "web" ? wrapped(webSource) : wrapped(null)
    ),
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
