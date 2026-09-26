/** Runtime view of the `northwind-stack` services: one container per service on apps-2. */
import { http } from "msw";
import { wrapped } from "../../handlers";
import { ago } from "../time";
import { apps2, fullId, stackContainerName, stackServices } from "./data";

const serviceIds = Object.fromEntries(
  stackServices.map((service) => [fullId(service.short), service])
) as Record<string, (typeof stackServices)[number]>;

/** Runtime ids of the services, for the runtime handlers' stats and processes. */
export const stackRuntimeNames = Object.fromEntries(
  Object.entries(serviceIds).map(([id, service]) => [id, service.name])
);

function serviceInspect(id: string, service: (typeof stackServices)[number]) {
  const name = stackContainerName(service.name);
  return {
    Id: id,
    Name: `/${name}`,
    Created: ago(2, "d"),
    Image: `sha256:${fullId(service.short, 9)}`,
    Platform: "linux",
    RestartCount: 0,
    State: {
      Status: service.state,
      Running: service.state === "running",
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: 30_000 + service.name.length * 17,
      ExitCode: 0,
      Error: "",
      StartedAt: ago(2, "d"),
      FinishedAt: "0001-01-01T00:00:00Z",
      ...(service.health === "none"
        ? {}
        : { Health: { Status: service.health, FailingStreak: 0, Log: [] } }),
    },
    Config: {
      Hostname: service.name,
      Image: service.image,
      Labels: {
        "com.docker.compose.project": "northwind-stack",
        "com.docker.compose.service": service.name,
      },
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Memory: service.name === "worker" ? 512 * 1024 ** 2 : 0,
      NetworkMode: "northwind-stack_default",
    },
    Mounts: [],
    NetworkSettings: {
      Networks: { "northwind-stack_default": { Aliases: [service.name] } },
      Ports: {},
    },
    nodeId: apps2.id,
    availability: "available" as const,
    gpuAttachment: { mode: "none" as const, deviceIds: [] },
  };
}

export function dockerComposeRuntimeHandlers() {
  return [
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId", ({ params }) => {
      const service = serviceIds[String(params.containerId)];
      return service ? wrapped(serviceInspect(String(params.containerId), service)) : undefined;
    }),
  ];
}
