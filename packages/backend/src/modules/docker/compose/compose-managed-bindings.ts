import { AppError } from '@/middleware/error-handler.js';
export interface ComposeServiceTarget {
  projectId: string;
  serviceName: string;
}
export interface ComposeManagedDatabasePatch {
  bindingId: string;
  networkName: string;
  hostAlias?: string;
  hostAddress?: string;
  environment: Record<string, string>;
}
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function encodeComposeServiceTarget(target: ComposeServiceTarget) {
  return `${target.projectId}:${encodeURIComponent(target.serviceName)}`;
}
export function decodeComposeServiceTarget(value: string): ComposeServiceTarget {
  const separator = value.indexOf(':');
  const projectId = separator < 0 ? '' : value.slice(0, separator);
  let serviceName = '';
  try {
    serviceName = separator < 0 ? '' : decodeURIComponent(value.slice(separator + 1));
  } catch {
    serviceName = '';
  }
  if (!PROJECT_ID_PATTERN.test(projectId) || !serviceName) {
    throw new AppError(400, 'INVALID_COMPOSE_SERVICE_TARGET', 'Compose service target is invalid');
  }
  return { projectId, serviceName };
}
