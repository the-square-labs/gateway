import { z } from 'zod';
import { FILE_UPLOAD_MAX_BYTES } from '@/modules/settings/general-settings.service.js';

// Docker's container name rule: [a-zA-Z0-9][a-zA-Z0-9_.-]+
const ContainerNameSchema = z
  .string()
  .min(2)
  .max(255)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/,
    'Invalid container name (must start with alphanumeric, then alphanumerics, _, ., or -)'
  );
const DOCKER_CONTAINER_PORTS_MAX = 256;
const DOCKER_STOP_TIMEOUT_MAX_SECONDS = 300;
const DOCKER_GPU_DEVICE_IDS_MAX = 32;
const DockerStopTimeoutSchema = z.number().int().min(0).max(DOCKER_STOP_TIMEOUT_MAX_SECONDS);
const DockerFilePathSchema = z
  .string()
  .min(1)
  .refine((path) => path.startsWith('/'), 'Path must be absolute')
  .refine((path) => !path.split('/').includes('..'), "Path must not contain '..'");

export const DockerGpuSelectionSchema = z
  .object({
    // An empty list is an intentional detach during a container recreation.
    // The daemon resolves every supplied ID against its own host inventory;
    // clients never submit host paths or Docker device requests directly.
    deviceIds: z
      .array(z.string().trim().min(1).max(256))
      .max(DOCKER_GPU_DEVICE_IDS_MAX)
      .superRefine((deviceIds, ctx) => {
        const seen = new Set<string>();
        for (const [index, deviceId] of deviceIds.entries()) {
          if (seen.has(deviceId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'GPU device IDs must be unique', path: [index] });
          }
          seen.add(deviceId);
        }
      }),
  })
  .strict();

// Container create
export const ContainerCreateSchema = z.object({
  image: z.string().min(1),
  registryId: z.string().uuid().optional(),
  name: ContainerNameSchema.optional(),
  ports: z
    .array(
      z.object({
        hostPort: z.number(),
        containerPort: z.number(),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      })
    )
    .max(DOCKER_CONTAINER_PORTS_MAX)
    .optional(),
  volumes: z
    .array(
      z.object({
        hostPath: z.string().optional(),
        containerPath: z.string(),
        name: z.string().optional(),
        readOnly: z.boolean().default(false),
      })
    )
    .optional(),
  env: z.record(z.string()).optional(),
  networks: z.array(z.string()).optional(),
  restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('no'),
  stopTimeout: DockerStopTimeoutSchema.optional(),
  gpu: DockerGpuSelectionSchema.optional(),
  labels: z.record(z.string()).optional(),
  command: z.array(z.string()).optional(),
});

// Container update (pull + redeploy)
export const ContainerUpdateSchema = z.object({
  tag: z.string().optional(),
  env: z.record(z.string()).optional(),
  removeEnv: z.array(z.string()).optional(),
});

// Container live update (no recreation — restart policy + resource limits)
export const ContainerLiveUpdateSchema = z.object({
  restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).optional(),
  maxRetries: z.number().int().min(0).optional(),
  memoryLimit: z.number().int().min(0).optional(), // bytes
  memorySwap: z.number().int().optional(), // bytes, -1 = unlimited
  nanoCPUs: z.number().int().min(0).optional(), // 1e9 = 1 CPU
  cpuShares: z.number().int().min(0).optional(),
  pidsLimit: z.number().int().min(0).optional(),
});

// Container recreate with new config (requires container recreation)
export const ContainerRecreateSchema = z.object({
  image: z.string().min(1).optional(),
  ports: z
    .array(
      z.object({
        hostPort: z.number().int().min(0).max(65535),
        containerPort: z.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      })
    )
    .max(DOCKER_CONTAINER_PORTS_MAX)
    .optional(),
  mounts: z
    .array(
      z.object({
        hostPath: z.string().optional(),
        containerPath: z.string().min(1),
        name: z.string().optional(),
        readOnly: z.boolean().default(false),
      })
    )
    .optional(),
  entrypoint: z.array(z.string()).optional(),
  command: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  hostname: z.string().optional(),
  labels: z.record(z.string()).optional(),
  stopTimeout: DockerStopTimeoutSchema.optional(),
  restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).optional(),
  maxRetries: z.number().int().min(0).optional(),
  memoryLimit: z.number().int().min(0).optional(),
  memorySwap: z.number().int().optional(),
  nanoCPUs: z.number().int().min(0).optional(),
  cpuShares: z.number().int().min(0).optional(),
  pidsLimit: z.number().int().min(0).optional(),
  gpu: DockerGpuSelectionSchema.optional(),
});

// Container action params
export const ContainerStopSchema = z.object({ timeout: DockerStopTimeoutSchema.optional() });
export const ContainerKillSchema = z.object({ signal: z.string().default('SIGKILL') });
export const ContainerRenameSchema = z.object({ name: ContainerNameSchema });
export const ContainerDuplicateSchema = z.object({ name: ContainerNameSchema });
export const ContainerArchiveExportQuerySchema = z
  .object({
    imageMode: z.enum(['portable', 'registry']).default('portable'),
    includeWritableLayer: z.preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean().default(false)
    ),
    includeEnvironment: z.preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean().default(true)
    ),
    includeSecrets: z.preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean().default(false)
    ),
  })
  .superRefine((value, context) => {
    if (value.includeSecrets && !value.includeEnvironment) {
      context.addIssue({
        code: 'custom',
        path: ['includeSecrets'],
        message: 'Secrets can only be included when environment is included',
      });
    }
  });
const ContainerArchiveStringMappingsSchema = z
  .record(z.string().min(1).max(512), z.string().min(1).max(4096))
  .refine((value) => Object.keys(value).length <= 256, 'Too many archive mappings');
export const ContainerArchiveResolutionSchema = z.object({
  networks: ContainerArchiveStringMappingsSchema.optional(),
  createNetworks: z.array(z.string().min(1).max(512)).max(256).optional(),
  bindPaths: ContainerArchiveStringMappingsSchema.optional(),
  volumes: ContainerArchiveStringMappingsSchema.optional(),
  createVolumes: z.array(z.string().min(1).max(512)).max(256).optional(),
  ports: z
    .record(z.string().min(1).max(128), z.number().int().min(0).max(65535))
    .refine((value) => Object.keys(value).length <= 256, 'Too many archive port mappings')
    .optional(),
});

const ContainerArchivePlanNetworkSchema = z
  .object({
    name: z.string().min(1).max(512),
    driver: z.string().max(512).optional(),
    subnet: z.string().max(512).optional(),
    gateway: z.string().max(512).optional(),
    createable: z.boolean(),
    createNew: z.boolean().optional(),
    requiresMapping: z.boolean().optional(),
  })
  .strict();
const ContainerArchivePlanMountSchema = z
  .object({
    type: z.enum(['bind', 'volume']),
    source: z.string().min(1).max(4096),
    target: z.string().min(1).max(4096),
    readOnly: z.boolean(),
    driver: z.string().max(512).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    createNew: z.boolean().optional(),
    requiresMapping: z.boolean().optional(),
  })
  .strict();
const ContainerArchivePlanPortSchema = z
  .object({
    containerPort: z.number().int().min(1).max(65535),
    hostPort: z.number().int().min(0).max(65535),
    protocol: z.enum(['tcp', 'udp']),
  })
  .strict();

export const ContainerArchivePlanSchema = z
  .object({
    networks: z.array(ContainerArchivePlanNetworkSchema).max(64),
    mounts: z.array(ContainerArchivePlanMountSchema).max(256),
    ports: z.array(ContainerArchivePlanPortSchema).max(DOCKER_CONTAINER_PORTS_MAX),
  })
  .strict();

export const ContainerArchiveImportQuerySchema = z.object({
  name: ContainerNameSchema,
  resolution: z
    .string()
    .max(32 * 1024)
    .optional(),
});

// Image pull
export const ImagePullSchema = z.object({
  imageRef: z.string().min(1),
  registryId: z.string().uuid().optional(),
});

// Volume create
export const VolumeCreateSchema = z.object({
  name: z.string().min(1),
  driver: z.string().default('local'),
  labels: z.record(z.string()).optional(),
});

export const VolumeRenameSchema = z.object({
  name: z.string().min(1),
});

export const VolumeLabelsUpdateSchema = z.object({
  labels: z.record(z.string()).default({}),
});

// Network create
export const NetworkCreateSchema = z.object({
  name: z.string().min(1),
  driver: z.string().default('bridge'),
  subnet: z.string().optional(),
  gateway: z.string().optional(),
});

// Network connect/disconnect
export const NetworkConnectSchema = z.object({
  containerId: z.string().min(1),
});

// Log query
export const DOCKER_LOG_TAIL_MAX = 1000;

export const LogQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(DOCKER_LOG_TAIL_MAX).default(100),
  timestamps: z.coerce.boolean().default(false),
});

// File browse
export const FileBrowseSchema = z.object({
  path: DockerFilePathSchema.default('/'),
});

// File write
export const DOCKER_FILE_WRITE_MAX_BYTES = FILE_UPLOAD_MAX_BYTES;

export const FileUploadInitSchema = z.object({
  path: DockerFilePathSchema,
  totalBytes: z.number().int().min(0).max(FILE_UPLOAD_MAX_BYTES),
});

export const FileUploadChunkQuerySchema = z.object({
  offset: z.coerce.number().int().min(0),
});

export const FileUploadCompleteSchema = z.object({
  path: DockerFilePathSchema,
  totalBytes: z.number().int().min(0).max(FILE_UPLOAD_MAX_BYTES),
});

export const FileMoveSchema = z.object({
  fromPath: DockerFilePathSchema,
  toPath: DockerFilePathSchema,
});

// Env update
export const EnvUpdateSchema = z.object({
  env: z.record(z.string()).optional(),
  removeEnv: z.array(z.string()).optional(),
});

// ─── Registry schemas ─────────────────────────────────────────────────

export const RegistryCreateSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
  trustedAuthRealm: z.string().optional(),
  scope: z.enum(['global', 'node']).default('global'),
  nodeId: z.string().uuid().optional(),
});

export const RegistryUpdateSchema = RegistryCreateSchema.partial();

// ─── Template schemas ─────────────────────────────────────────────────

export const TemplateCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  config: z.object({}).passthrough(),
});

export const TemplateUpdateSchema = TemplateCreateSchema.partial();

export const TemplateDeploySchema = z.object({
  nodeId: z.string().uuid(),
  overrides: z.object({}).passthrough().optional(),
});

// ─── Secret schemas ──────────────────────────────────────────────────

export const SecretCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid environment variable name'),
  value: z.string(),
});

export const SecretUpdateSchema = z.object({
  value: z.string(),
});

// ─── Gateway HTTP health checks ──────────────────────────────────────

export const DockerHealthCheckUpsertSchema = z
  .object({
    enabled: z.boolean().default(false),
    scheme: z.enum(['http', 'https']).default('http'),
    hostPort: z.number().int().min(1).max(65535).nullable().optional(),
    containerPort: z.number().int().min(1).max(65535).nullable().optional(),
    path: z.string().min(1).max(500).default('/'),
    statusMin: z.number().int().min(100).max(599).default(200),
    statusMax: z.number().int().min(100).max(599).default(399),
    expectedBody: z.string().max(5000).nullable().optional(),
    bodyMatchMode: z.enum(['includes', 'exact', 'starts_with', 'ends_with']).default('includes'),
    intervalSeconds: z.number().int().min(5).max(86400).default(30),
    timeoutSeconds: z.number().int().min(1).max(120).default(5),
    slowThreshold: z.number().int().min(1).max(120000).default(1000),
  })
  .refine((value) => value.statusMin <= value.statusMax, {
    message: 'Minimum healthy status cannot be greater than maximum status',
    path: ['statusMin'],
  });

// ─── Type exports ─────────────────────────────────────────────────────

export type ContainerCreateInput = z.infer<typeof ContainerCreateSchema>;
export type ContainerUpdateInput = z.infer<typeof ContainerUpdateSchema>;
export type ContainerLiveUpdateInput = z.infer<typeof ContainerLiveUpdateSchema>;
export type ContainerRecreateInput = z.infer<typeof ContainerRecreateSchema>;
export type VolumeCreateInput = z.infer<typeof VolumeCreateSchema>;
export type NetworkCreateInput = z.infer<typeof NetworkCreateSchema>;
export type RegistryCreateInput = z.infer<typeof RegistryCreateSchema>;
export type RegistryUpdateInput = z.infer<typeof RegistryUpdateSchema>;
export type TemplateCreateInput = z.infer<typeof TemplateCreateSchema>;
export type TemplateUpdateInput = z.infer<typeof TemplateUpdateSchema>;
export type TemplateDeployInput = z.infer<typeof TemplateDeploySchema>;
export type DockerHealthCheckUpsertInput = z.infer<typeof DockerHealthCheckUpsertSchema>;
