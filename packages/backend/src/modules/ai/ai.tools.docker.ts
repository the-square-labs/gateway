import type { AIToolDefinition } from './ai.types.js';

const STABLE_CONTAINER_REFERENCE_DESCRIPTION =
  'Exact stable container name returned by find_resource or inspect (preferred). A runtime ID is also accepted, but never manually shorten or retype one.';

export const DOCKER_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'create_docker_container',
    description:
      'Create and start a new Docker container on a node from an image already present on that node. Before first creation, use list_docker_images and pull_docker_image when the requested image is absent, then wait for the pull task to complete. Volume mounts may reference only existing Gateway-managed volumes; never provide host bind paths. Secure runtime requires a healthy Secure Runtime capability on the node and does not support GPU or device attachments. For public Docker Hub images such as nginx:alpine, omit registryId; a saved registry is not required.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        image: { type: 'string', description: 'Image reference (e.g. nginx:latest, ubuntu:24.04)' },
        registryId: {
          type: 'string',
          description:
            'Optional saved private/custom registry UUID. Omit for public Docker Hub images; never pass an empty string.',
        },
        name: { type: 'string', description: 'Container name (optional, auto-generated if omitted)' },
        ports: {
          type: 'array',
          description: 'Port mappings',
          items: {
            type: 'object',
            properties: {
              hostPort: { type: 'number' },
              containerPort: { type: 'number' },
              protocol: { type: 'string', enum: ['tcp', 'udp'], description: 'Default: tcp' },
            },
            required: ['hostPort', 'containerPort'],
          },
        },
        volumes: {
          type: 'array',
          description:
            'Existing Gateway-managed named-volume mounts. Supplying mounts also requires docker:containers:mounts for the node.',
          items: {
            type: 'object',
            properties: {
              containerPath: { type: 'string' },
              name: { type: 'string', description: 'Existing Gateway-managed volume name' },
              readOnly: { type: 'boolean' },
            },
            required: ['containerPath', 'name'],
          },
        },
        env: { type: 'object', description: 'Environment variables as key-value pairs' },
        networks: { type: 'array', items: { type: 'string' }, description: 'Network names to connect to' },
        restartPolicy: {
          type: 'string',
          enum: ['no', 'always', 'unless-stopped', 'on-failure'],
          description: 'Default: no',
        },
        runtimeProfile: {
          type: 'string',
          enum: ['default', 'secure'],
          description: 'Container isolation profile. Default: default (runc). Secure uses gVisor runsc.',
        },
        stopTimeout: {
          type: 'integer',
          minimum: 0,
          maximum: 300,
          description: 'Container stop grace period in seconds, 0-300. Default: Gateway fallback 20 seconds.',
        },
        labels: { type: 'object', description: 'Container labels as key-value pairs' },
        command: { type: 'array', items: { type: 'string' }, description: 'Override container command' },
      },
      required: ['nodeId', 'image'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:create',
    invalidateStores: ['containers'],
  },
  {
    name: 'list_docker_containers',
    description: 'List Docker containers on a specific node with their status, image, ports, and resource usage.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (required)' },
        search: { type: 'string', description: 'Optional search over container ID, name, image, status, and ports' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'get_docker_container',
    description:
      'Get detailed information about a specific Docker container including config, state, mounts, and network settings.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'execute_docker_container_console_command',
    description:
      'Run a one-shot command inside a Docker container console. This is destructive by policy even for read-looking commands. Use command as argv, for example ["sh","-lc","pwd && ls -la"]. Clearly dangerous commands are blocked; commands with risky patterns require explicit user approval.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command argv to execute. Use ["sh","-lc","..."] for shell syntax.',
        },
        user: { type: 'string', description: 'Optional container user for docker exec.' },
      },
      required: ['nodeId', 'containerId', 'command'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:console',
    invalidateStores: ['containers'],
  },
  {
    name: 'list_docker_deployments',
    description:
      'List blue/green Docker deployments on a specific node. Use this before acting on managed deployment containers; deployment rows include activeSlot, slots, routes, status, and health.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (required)' },
        search: { type: 'string', description: 'Optional search over deployment name, image, status, and routes' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'get_docker_deployment',
    description:
      'Get detailed information about a blue/green Docker deployment by deployment ID. Use deploymentId, not the active slot container ID.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'start_docker_deployment',
    description:
      'Start a stopped blue/green Docker deployment through the deployment layer. Do not start the underlying managed container directly.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'stop_docker_deployment',
    description:
      'Stop a blue/green Docker deployment through the deployment layer. Do not stop the underlying managed container directly.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'restart_docker_deployment',
    description:
      'Restart a blue/green Docker deployment through the deployment layer. Use this instead of restarting the active slot container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'kill_docker_deployment',
    description:
      'Force-kill a blue/green Docker deployment through the deployment layer. Prefer stop_docker_deployment unless an immediate kill is explicitly requested.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'deploy_docker_deployment',
    description:
      'Deploy a new inactive slot for a blue/green Docker deployment, optionally with a full image reference or a new tag. This is the deployment-safe replacement for updating a managed slot container image.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
        image: { type: 'string', description: 'Optional full image reference to deploy' },
        tag: { type: 'string', description: 'Optional tag applied to the current deployment image repository' },
        registryId: { type: 'string', description: 'Optional Docker registry UUID for pulling the image' },
        env: { type: 'object', description: 'Optional environment overrides for the new deployment config' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers', 'tasks'],
  },
  {
    name: 'switch_docker_deployment_slot',
    description:
      'Switch a blue/green Docker deployment to the specified slot. Use only with the Gateway deployment ID and slot name, not a container ID.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
        slot: { type: 'string', enum: ['blue', 'green'], description: 'Target slot to make active' },
        force: { type: 'boolean', description: 'Force switch even if health checks are not healthy (default false)' },
      },
      required: ['nodeId', 'deploymentId', 'slot'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'rollback_docker_deployment',
    description: 'Rollback a blue/green Docker deployment to the inactive previous slot.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
        force: { type: 'boolean', description: 'Force rollback even if health checks are not healthy (default false)' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'stop_docker_deployment_slot',
    description:
      'Stop an inactive blue/green deployment slot. The active slot cannot be stopped by this tool; use stop_docker_deployment to stop the whole deployment.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        deploymentId: { type: 'string', description: 'Gateway deployment ID' },
        slot: { type: 'string', enum: ['blue', 'green'], description: 'Inactive slot to stop' },
      },
      required: ['nodeId', 'deploymentId', 'slot'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'start_docker_container',
    description: 'Start a stopped Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'stop_docker_container',
    description: 'Stop a running Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        timeout: {
          type: 'integer',
          minimum: 0,
          maximum: 300,
          description: 'Seconds to wait before killing. If omitted, uses the container stop grace setting, then 20.',
        },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'restart_docker_container',
    description: 'Restart a Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        timeout: {
          type: 'integer',
          minimum: 0,
          maximum: 300,
          description: 'Seconds to wait before killing. If omitted, uses the container stop grace setting, then 20.',
        },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'remove_docker_container',
    description: 'Remove a Docker container. The container must be stopped first.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        force: {
          type: 'boolean',
          description: 'Force removal of a stopped container if Docker requires it (default false)',
        },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:delete',
    invalidateStores: ['containers'],
  },
  {
    name: 'update_docker_container_image',
    description:
      'Update a Docker container to a different image tag. Pulls the new image, then recreates the container with the new image while preserving all other settings (ports, volumes, env, etc.). Use this to upgrade/downgrade container versions.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        imageTag: { type: 'string', description: 'New image tag (e.g. "1.25", "latest", "v2.0.0")' },
      },
      required: ['nodeId', 'containerId', 'imageTag'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers', 'tasks'],
  },
  {
    name: 'rename_docker_container',
    description: 'Rename a Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        name: { type: 'string', description: 'New container name' },
      },
      required: ['nodeId', 'containerId', 'name'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:edit',
    invalidateStores: ['containers'],
  },
  {
    name: 'duplicate_docker_container',
    description: 'Clone a Docker container with a new name. Copies config, ports, volumes, env, and secrets.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        name: { type: 'string', description: 'Name for the new container' },
      },
      required: ['nodeId', 'containerId', 'name'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:create',
    requiredScopes: ['docker:containers:view', 'docker:containers:environment', 'docker:containers:secrets'],
    invalidateStores: ['containers'],
  },
  {
    name: 'get_docker_container_stats',
    description: 'Get live resource usage stats for a Docker container (CPU%, memory, network I/O, PIDs).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'get_docker_container_logs',
    description: 'Get recent log output from a Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        tail: { type: 'number', description: 'Number of lines from the end (default 100)' },
        timestamps: { type: 'boolean', description: 'Include timestamps (default false)' },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },

  // ── Docker: Images ──
  {
    name: 'list_docker_images',
    description: 'List Docker images on a specific node with their tags, size, and creation date.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (required)' },
        search: { type: 'string', description: 'Optional search over image ID, tags, and digests' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:images:view',
    invalidateStores: [],
  },
  {
    name: 'pull_docker_image',
    description:
      'Pull a Docker image onto a node. Public Docker Hub images such as nginx:alpine are pulled directly with registryId omitted; never create a saved Docker Hub registry just to pull a public image.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        imageRef: { type: 'string', description: 'Image reference (e.g. nginx:latest, ghcr.io/org/app:v2)' },
        registryId: {
          type: 'string',
          description:
            'Optional saved private/custom registry UUID. Omit for public Docker Hub images; never pass an empty string.',
        },
      },
      required: ['nodeId', 'imageRef'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:images:pull',
    invalidateStores: ['images'],
  },

  {
    name: 'remove_docker_image',
    description: 'Remove a Docker image from a node.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
        imageId: { type: 'string', description: 'Image ID or reference (e.g. sha256:abc... or nginx:1.25)' },
        force: { type: 'boolean', description: 'Force remove even if in use (default false)' },
      },
      required: ['nodeId', 'imageId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:images:delete',
    invalidateStores: ['images'],
  },
  {
    name: 'prune_docker_images',
    description: 'Remove all unused Docker images from a node to free disk space. Returns reclaimed space.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID' },
      },
      required: ['nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:images:delete',
    invalidateStores: ['images'],
  },

  // ── Docker: Volumes & Networks ──
  {
    name: 'list_docker_volumes',
    description:
      'List Gateway-managed volumes plus legacy volumes still attached to visible Gateway containers on a specific node. Orphaned unmanaged volumes are hidden.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (required)' },
        search: { type: 'string', description: 'Optional search over volume name, driver, mountpoint, and users' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:volumes:view',
    invalidateStores: [],
  },
  {
    name: 'list_docker_networks',
    description: 'List Docker networks on a specific node.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (required)' },
        search: { type: 'string', description: 'Optional search over network ID, name, driver, and scope' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:networks:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_registry',
    description:
      'Manage saved private or custom Docker registries. Operations: list, get, create, update, delete, test, test_direct. Do not create a registry for public Docker Hub images; pull those directly without registryId. Mutating operations require the corresponding docker:registries:* scope.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'test', 'test_direct'],
        },
        registryId: { type: 'string', description: 'Registry UUID for get/update/delete/test' },
        nodeId: { type: 'string', description: 'Optional node filter for list, or node scoped registry owner' },
        name: { type: 'string' },
        url: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        trustedAuthRealm: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'node'] },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:registries:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_volume',
    description:
      'Create or delete Docker volumes on a node. Create always produces a regular Gateway-managed local volume and accepts no driver setting. Disk-image creation/resizing and legacy-volume adoption remain explicit UI/REST actions. Listing is available via list_docker_volumes.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'delete'] },
        nodeId: { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['operation', 'nodeId', 'name'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:volumes:create',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_network',
    description:
      'Create, delete, connect, or disconnect Docker networks on a node. Listing is available via list_docker_networks.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'delete', 'connect', 'disconnect'] },
        nodeId: { type: 'string' },
        networkId: { type: 'string', description: 'Network ID or name for delete/connect/disconnect' },
        name: { type: 'string', description: 'Network name for create' },
        driver: { type: 'string' },
        subnet: { type: 'string' },
        gateway: { type: 'string' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:networks:create',
    invalidateStores: [],
  },
  {
    name: 'list_docker_builds',
    description:
      'List Git-source Docker builds visible to the caller, including exact commit, status, Build Worker, immutable artifact, policy result, and target resource.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Optional Docker runtime node filter' },
        sourceBindingId: { type: 'string', description: 'Optional source binding UUID' },
        status: {
          type: 'string',
          enum: [
            'queued',
            'claimed',
            'checking_out',
            'building',
            'scanning',
            'pushing',
            'deploying',
            'succeeded',
            'failed',
            'cancelled',
            'superseded',
          ],
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default: 20' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_source',
    description:
      'Inspect, attach, update, remove, resolve, or manually build the Git source bound directly to an existing Docker container or blue/green deployment. Repository identity is selected through an existing allowlisted Git integration; builds always resolve an exact commit and deploy only an approved immutable digest.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'upsert', 'remove', 'resolve', 'build', 'admission'] },
        targetType: { type: 'string', enum: ['container', 'deployment'] },
        nodeId: { type: 'string', description: 'Docker runtime node ID' },
        containerName: { type: 'string', description: 'Exact stable container name' },
        deploymentId: { type: 'string', description: 'Blue/green deployment UUID' },
        connectorId: { type: 'string', description: 'Allowlisted Git integration UUID' },
        projectId: { type: 'string', description: 'Allowlisted repository project UUID' },
        branch: { type: 'string' },
        dockerfilePath: { type: 'string', description: 'Repository-relative Dockerfile path' },
        contextPath: { type: 'string', description: 'Repository-relative build context' },
        autoBuild: { type: 'boolean', description: 'Automatically build newly detected commits' },
        autoDeploy: { type: 'boolean' },
        buildArgs: { type: 'object', description: 'Non-secret build arguments' },
        buildSecretNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Write-only Build Secret IDs configured separately on the source binding',
        },
        policy: {
          type: 'object',
          description: 'Artifact policy containing the vulnerability blocking threshold',
        },
        commitSha: { type: 'string', description: 'Optional exact current commit for a manual build' },
        force: { type: 'boolean', description: 'Queue a new attempt even when this commit already has a build' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: ['containers'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_docker_task',
    description: 'List or get Docker background tasks for image pulls, container updates, and webhook actions.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'get'] },
        taskId: { type: 'string' },
        nodeId: { type: 'string' },
        status: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['operation'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:tasks',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_container_config',
    description:
      'Manage container env, files, secrets, webhooks, and HTTP health checks. Container file list/read requires docker:containers:files:read; write requires docker:containers:files:write. Other operation-specific environment/secrets/webhooks/edit/view scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'get_env',
            'update_env',
            'list_files',
            'read_file',
            'write_file',
            'list_secrets',
            'create_secret',
            'update_secret',
            'delete_secret',
            'get_webhook',
            'upsert_webhook',
            'delete_webhook',
            'regenerate_webhook_token',
            'get_health_check',
            'upsert_health_check',
            'test_health_check',
          ],
        },
        targetType: { type: 'string', enum: ['container', 'deployment'], description: 'Defaults to container' },
        nodeId: { type: 'string' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        containerName: { type: 'string' },
        deploymentId: { type: 'string' },
        secretId: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        reveal: { type: 'boolean' },
        env: { type: 'object', description: 'Environment key/value map for update_env' },
        removeEnv: { type: 'array', items: { type: 'string' } },
        path: { type: 'string', description: 'Container file path' },
        content: { type: 'string', description: 'UTF-8 text file content for write_file' },
        enabled: { type: 'boolean', description: 'Webhook or health check enabled state' },
        healthCheck: { type: 'object', description: 'Docker health check configuration' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },
];
