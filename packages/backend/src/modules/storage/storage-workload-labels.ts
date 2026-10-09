import type { ManagedWorkloadLabels } from '@/modules/managed-workloads/managed-workload-labels.js';
import { UPDATE_REFUSED_PREFIX } from '@/modules/managed-workloads/managed-workload-refusal.js';

/**
 * Managed-storage vocabulary for {@link ManagedWorkloadLifecycle}. Reproduces
 * the codes/messages for managed storage workload management.
 */
export const STORAGE_WORKLOAD_LABELS: ManagedWorkloadLabels = {
  notFound: { code: 'MANAGED_STORAGE_NOT_FOUND', message: 'Managed storage cluster not found' },
  operationPending: {
    code: 'MANAGED_STORAGE_OPERATION_PENDING',
    message: 'Managed storage operation is still being reconciled',
  },
  operationMismatch: {
    code: 'MANAGED_STORAGE_OPERATION_PENDING',
    message: 'Managed storage operation does not match its pending state',
  },
  invalidLifecycle: (required, target) => ({
    code: 'MANAGED_STORAGE_INVALID_LIFECYCLE_STATE',
    message: `Managed storage must be ${required} before it can be ${target}`,
  }),
  failed: (operation, detail) =>
    detail ? `Managed storage ${operation} failed: ${detail}` : `Managed storage ${operation} failed`,
  reconciling: 'Managed storage operation outcome is being reconciled',
  // Without it a refused resize read "Managed storage update failed: …", which the core does not answer with 409
  // MANAGED_STORAGE_UPDATE_REFUSED (stand rc.8, F-6).
  refused: (_operation, detail) => `${UPDATE_REFUSED_PREFIX}${detail}`,
  waiting: (operation, detail) => `Managed storage ${operation} is retried automatically: ${detail}`,
};
