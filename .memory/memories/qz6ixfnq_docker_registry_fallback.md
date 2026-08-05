---
{
  "id": "qz6ixfnq",
  "file_name": "qz6ixfnq_docker_registry_fallback",
  "tags": [
    "docker",
    "gateway",
    "gotcha",
    "mcp",
    "private-registry",
    "registry"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.65,
  "importance": 0.8,
  "created_at": 1777391029865,
  "updated_at": 1780942233536
}
---
In gateway, private Docker registry inference can encounter multiple saved docker_registries rows with the same URL/host but different credentials/scopes (for example DFK Registry and DFK Stazion Registry both at https://registry.dfk-algotrade.com). A 2026-04-28 live stazion-backend incident showed that inferred single-host lookup can pick credentials without access to the target image and fail with insufficient_scope. Keep explicit registry selection available on every Docker image-pull surface. As of the MCP fix, create_docker_container and pull_docker_image must expose optional registryId in their AI/MCP tool schemas; create_docker_container must pass registryId through ContainerCreateSchema into DockerManagementService.createContainer, and pull_docker_image must resolve DockerRegistryService.resolveAuthForImagePull(nodeId, imageRef, registryId), prefix the registry host for short image refs, and call DockerManagementService.pullImage with authJson and the resolved registryId. Recreate/deployment flows should continue trying resolveAuthCandidatesForImagePull candidates when no explicit registryId is supplied.
