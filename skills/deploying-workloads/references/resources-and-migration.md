# Images, volumes, networks, registries, and migration

## Images and registries

- `list_docker_images`, `pull_docker_image`, `remove_docker_image`, `prune_docker_images`. Pull an approved image onto the selected Docker Node before creating a resource from it, and wait for the pull Task.
- `manage_docker_registry` stores private registry credentials, globally or per Node; they are never returned after storage. Do not create a registry entry to pull a public Docker Hub image. Never ask for a registry password in chat: let the user enter it in the Gateway Console.

## Volumes

- `manage_docker_volume` creates Gateway-managed local volumes only: `storageKind: "regular"`, or `"disk-image"` with `capacityBytes` (Personal plan or higher and a compatible Node).
- `operation: "resize"` only grows a volume. `operation: "adopt"` brings an eligible legacy local-driver volume under management without copying data.
- Never propose a host bind mount for a new or changed mount.

## Networks and folders

- `manage_docker_network` lists, creates, removes, connects, and disconnects networks.
- `list_resource_folders({ resourceType: "docker", dockerResourceType })` and `manage_resource_folder` organize Containers, Compose Projects, images, networks, and volumes. See `read_gateway_documentation({ topic: "folders" })`.

## Cross-node migration

`manage_docker_migration` operations: `preflight`, `start`, `list`, `get`, `cancel`, `retry_cleanup`, `resolve`.

- Always run `preflight` first and pass its exact fingerprint to `start`. It needs `docker:containers:migrate`, an OAuth manual-approval scope.
- Secure Runtime and GPU-attached workloads are not eligible.
- Done means the resource is healthy on the target Node and source cleanup completed.

## Archive export and import

- `download_docker_archive` exports a Container; it needs `docker:containers:export`, plus `docker:containers:secrets` to include secret values. Secure Runtime workloads and Containers with host bind mounts cannot be exported.
- `upload_docker_container_archive` imports one; host bind mounts are rejected.
- An export that includes secrets is itself a secret. Keep it out of chat, repositories, and shared storage.

## Isolation profiles

The **Secure** profile (gVisor) cannot attach GPUs or devices, use host bind mounts, migrate between Nodes, or be exported. Changing the profile always recreates the workload. Docker Nodes report Secure Runtime setup state; install it through Gateway's setup entrypoint, not ad hoc console commands.

## Scopes

`docker:containers:view|create|edit|manage|environment|delete|console|files:read|files:write|export|secrets|webhooks|mounts|migrate`, `docker:compose:view|create|manage|delete`, `docker:images:view|pull|delete`, `docker:volumes:*`, `docker:networks:*`, `docker:registries:*`, `docker:tasks`, `docker:tasks:manage`, `docker:folders:manage`. A Node-level grant covers every Container and Deployment on that Node; a child grant (`<nodeId>/<resourceId>`) covers one. Console, file, export, secret, mount, and migration scopes are OAuth manual-approval scopes. Full table: [Scopes reference](https://docs.goodgateway.dev/en/identity/scopes-reference/).
