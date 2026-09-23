import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { extractRuntimeConfig, mergeRuntimeConfig } from './docker-runtime-config.js';
import {
  type ContainerRuntimeConfig,
  type NodeRuntimeCapacity,
  validateContainerRuntimeLimits,
} from './docker-runtime-limits.js';
import type { DockerRuntimeSettingsService } from './docker-runtime-settings.service.js';

export interface DockerRuntimeOperationContext {
  db: DrizzleClient;
  nodeDispatch: NodeDispatchService;
  nodeRegistry: NodeRegistryService;
  runtimeSettingsService?: DockerRuntimeSettingsService;
  parseResult: (result: { success: boolean; error?: string; detail?: string }) => unknown;
}

function normalizePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function getNodeRuntimeCapacity(
  context: DockerRuntimeOperationContext,
  nodeId: string
): Promise<NodeRuntimeCapacity> {
  const [row] = await context.db
    .select({
      capabilities: nodes.capabilities,
      lastHealthReport: nodes.lastHealthReport,
    })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', 'Node not found');
  }

  const liveHealth = context.nodeRegistry.getNode(nodeId)?.lastHealthReport ?? row.lastHealthReport ?? null;
  const capabilities = (row.capabilities ?? {}) as Record<string, unknown>;

  return {
    cpuCores: normalizePositiveNumber(capabilities.cpuCores),
    memoryBytes: normalizePositiveNumber(liveHealth?.systemMemoryTotalBytes),
    swapBytes: normalizeNonNegativeNumber(liveHealth?.swapTotalBytes),
  };
}

async function getCurrentRuntimeConfig(
  context: DockerRuntimeOperationContext,
  nodeId: string,
  containerId: string
): Promise<ContainerRuntimeConfig> {
  const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
  const data = context.parseResult(result) as Record<string, any>;
  const hostConfig = (data?.HostConfig ?? {}) as Record<string, unknown>;

  return {
    memoryLimit: normalizeNonNegativeNumber(hostConfig.Memory) ?? 0,
    memorySwap: hostConfig.MemorySwap === -1 ? -1 : (normalizeNonNegativeNumber(hostConfig.MemorySwap) ?? 0),
    nanoCPUs: normalizeNonNegativeNumber(hostConfig.NanoCPUs) ?? 0,
    cpuQuota: normalizeNonNegativeNumber(hostConfig.CPUQuota) ?? 0,
    cpuPeriod: normalizeNonNegativeNumber(hostConfig.CPUPeriod) ?? 0,
  };
}

export async function persistDockerRuntimeSettings(
  context: DockerRuntimeOperationContext,
  nodeId: string,
  containerName: string,
  patch: Record<string, unknown>
): Promise<ContainerRuntimeConfig | null> {
  if (!context.runtimeSettingsService) return null;

  const incoming = extractRuntimeConfig(patch);
  if (Object.values(incoming).every((value) => value === undefined)) {
    return await context.runtimeSettingsService.get(nodeId, containerName);
  }

  const existing = (await context.runtimeSettingsService.get(nodeId, containerName)) ?? {};
  const merged = mergeRuntimeConfig(existing, incoming);
  await context.runtimeSettingsService.replace(nodeId, containerName, merged);
  return Object.keys(merged).length > 0 ? merged : null;
}

export async function applyPersistedDockerRuntimeSettingsToConfig(
  context: DockerRuntimeOperationContext,
  nodeId: string,
  containerName: string,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const persisted = await persistDockerRuntimeSettings(context, nodeId, containerName, config);
  if (!persisted) return config;
  return { ...persisted, ...config };
}

/**
 * Same result as applyPersistedDockerRuntimeSettingsToConfig without saving
 * the request, so callers can validate before persisting.
 */
export async function mergePersistedDockerRuntimeSettingsIntoConfig(
  context: DockerRuntimeOperationContext,
  nodeId: string,
  containerName: string,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!context.runtimeSettingsService) return config;
  const existing = await context.runtimeSettingsService.get(nodeId, containerName);
  const incoming = extractRuntimeConfig(config);
  const merged = Object.values(incoming).every((value) => value === undefined)
    ? existing
    : mergeRuntimeConfig(existing ?? {}, incoming);
  if (!merged || Object.keys(merged).length === 0) return config;
  return { ...merged, ...config };
}

export async function validateDockerRuntimeResourceConfig(
  context: DockerRuntimeOperationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>
) {
  const resourceConfig: ContainerRuntimeConfig = {
    memoryLimit: typeof config.memoryLimit === 'number' ? config.memoryLimit : undefined,
    memorySwap: typeof config.memorySwap === 'number' ? config.memorySwap : undefined,
    nanoCPUs: typeof config.nanoCPUs === 'number' ? config.nanoCPUs : undefined,
  };

  if (
    resourceConfig.memoryLimit === undefined &&
    resourceConfig.memorySwap === undefined &&
    resourceConfig.nanoCPUs === undefined
  ) {
    return;
  }

  const [capacity, current] = await Promise.all([
    getNodeRuntimeCapacity(context, nodeId),
    getCurrentRuntimeConfig(context, nodeId, containerId),
  ]);

  validateContainerRuntimeLimits(resourceConfig, current, capacity);
}
