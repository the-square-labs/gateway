export interface DockerImageUsageContainer {
  id: string;
  name: string;
  state: string;
  image: string;
  nodeId: string;
  nodeSlug: string;
}

export function normalizeDockerImageUsageContainers(
  containers: unknown,
  imageTag: string,
  nodeId: string,
  nodeSlug = ""
): DockerImageUsageContainer[] {
  return (Array.isArray(containers) ? containers : [])
    .map((container: any) => ({
      id: container.id ?? container.Id ?? "",
      name: container.name ?? container.Name ?? "",
      state: container.state ?? container.State ?? "",
      image: container.image ?? container.Image ?? "",
      nodeId,
      nodeSlug,
    }))
    .filter(
      (container) =>
        container.image === imageTag || container.image.split(":")[0] === imageTag.split(":")[0]
    );
}
