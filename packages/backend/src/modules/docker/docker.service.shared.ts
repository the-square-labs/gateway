import { createChildLogger } from '@/lib/logger.js';

export const logger = createChildLogger('DockerManagementService');
export const DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS = 20;
export const CONTAINER_LIFECYCLE_TIMEOUT_BUFFER_SECONDS = 30;
export const GPU_USAGE_INSPECTION_BATCH_SIZE = 8;

export type { ContainerTransition } from './docker-container-transitions.js';

export interface DockerGpuAttachmentUser {
  containerId: string;
  name: string;
  scopeResourceId: string | null;
  deviceIds: string[];
}
