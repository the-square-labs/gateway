import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

export function createNodeFileOperationContext(
  nodeDispatch: NodeDispatchService,
  auditService: AuditService,
  eventBus?: EventBusService
) {
  return { nodeDispatch, auditService, eventBus, parseResult: parseNodeCommandResult };
}

export function isNonEmptyAddressSubset(addresses: string[], allowedAddresses: string[]): boolean {
  const allowed = new Set(allowedAddresses);
  return addresses.length > 0 && addresses.every((address) => allowed.has(address));
}

export function orderedAddressesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

export function stripNodeHealthHistory<T extends { healthHistory?: unknown }>(node: T): Omit<T, 'healthHistory'> {
  const { healthHistory: _healthHistory, ...rest } = node;
  return rest;
}

export function parseNodeCommandResult(result: { success: boolean; error?: string; detail?: string }) {
  if (!result.success) {
    throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Command failed on daemon');
  }
  try {
    return result.detail ? JSON.parse(result.detail) : null;
  } catch {
    return result.detail;
  }
}
