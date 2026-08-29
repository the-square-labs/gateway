import type { DockerHealthEntry, DockerHealthStatus } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

export const DEFAULT_CONFIG = {
  enabled: false,
  scheme: 'http' as const,
  hostPort: null,
  containerPort: null,
  path: '/',
  statusMin: 200,
  statusMax: 399,
  expectedBody: null,
  bodyMatchMode: 'includes' as const,
  intervalSeconds: 30,
  timeoutSeconds: 5,
  slowThreshold: 1000,
  healthStatus: 'unknown' as DockerHealthStatus,
  lastHealthCheckAt: null,
  healthHistory: [] as DockerHealthEntry[],
};

export function healthAction(status: DockerHealthStatus) {
  if (status === 'online') return 'health.online';
  if (status === 'degraded') return 'health.degraded';
  if (status === 'offline') return 'health.offline';
  return 'health.unknown';
}

export function normalizePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function parseDispatchResult(result: { success: boolean; error?: string; detail?: string }) {
  if (!result.success) {
    throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Command failed on daemon');
  }
  return result.detail ? JSON.parse(result.detail) : null;
}
