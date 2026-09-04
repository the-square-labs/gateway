import { useRef } from "react";
import type { DockerAvailabilityResource } from "@/types";

function resourceKey(resource: DockerAvailabilityResource) {
  switch (resource.type) {
    case "container":
      return `${resource.type}:${resource.nodeId}:${resource.containerName}`;
    case "deployment":
      return `${resource.type}:${resource.deploymentId}`;
    case "compose":
      return `${resource.type}:${resource.composeProjectId}`;
  }
}

export function useStableAvailabilityResource(resource: DockerAvailabilityResource) {
  const key = resourceKey(resource);
  const stable = useRef({ key, resource });

  if (stable.current.key !== key) {
    stable.current = { key, resource };
  }

  return stable.current.resource;
}
