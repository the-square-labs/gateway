import type { DockerAvailabilityPolicy, DockerComposeProject } from "@/types";

export function projectComposeServicePolicy(
  policy: DockerAvailabilityPolicy | null,
  serviceName: string,
  sourceImage?: string | null
): DockerAvailabilityPolicy | null {
  if (!policy || policy.mode === "single" || policy.resourceKind !== "compose" || !serviceName)
    return null;
  return {
    ...policy,
    sourceImageReference: sourceImage ?? null,
    placements: policy.placements.map((placement) => {
      const containers = Array.isArray(placement.runtimeIdentity.containers)
        ? (placement.runtimeIdentity.containers as Array<Record<string, unknown>>)
        : [];
      const runtime = containers.find((container) => container.serviceName === serviceName);
      return {
        ...placement,
        serving: placement.serving && Boolean(runtime?.containerId || runtime?.containerName),
        runtimeIdentity: {
          ...placement.runtimeIdentity,
          containerId: runtime?.containerId,
          containerName: runtime?.containerName,
        },
      };
    }),
  };
}

export function composeServiceRows(
  project: DockerComposeProject,
  policy: DockerAvailabilityPolicy | null
): DockerComposeProject["services"] {
  if (!policy || policy.mode === "single") return project.services;
  const names = new Set([
    ...Object.keys(project.activeRevision?.normalizedModel.services ?? {}),
    ...project.services.map((service) => service.name),
  ]);
  return [...names].map((name) => {
    const observed = project.services.find((service) => service.name === name);
    const servicePolicy = projectComposeServicePolicy(policy, name);
    const placements =
      servicePolicy?.placements.filter((placement) => placement.actualState !== "removed") ?? [];
    const serving = placements.filter((placement) => placement.serving);
    return {
      name,
      image: project.activeRevision?.normalizedModel.services[name]?.image ?? observed?.image ?? "",
      state: !policy.shouldRun ? "stopped" : serving.length ? "running" : "pending",
      health: !policy.shouldRun
        ? "stopped"
        : serving.length && serving.every((placement) => placement.applicationHealth === "healthy")
          ? "healthy"
          : "unknown",
      containerIds: placements.flatMap((placement) =>
        typeof placement.runtimeIdentity.containerId === "string"
          ? [placement.runtimeIdentity.containerId]
          : []
      ),
    };
  });
}
