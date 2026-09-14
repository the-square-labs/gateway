import { describe, expect, it } from 'vitest';
import { STORAGE_WORKLOAD_LABELS } from './storage-workload-labels.js';

describe('STORAGE_WORKLOAD_LABELS', () => {
  it('reproduces the current managed storage not-found code/message', () => {
    expect(STORAGE_WORKLOAD_LABELS.notFound.code).toBe('MANAGED_STORAGE_NOT_FOUND');
    expect(STORAGE_WORKLOAD_LABELS.notFound.message).toBe('Managed storage cluster not found');
  });

  it('reproduces the current managed storage operation-pending code/message', () => {
    expect(STORAGE_WORKLOAD_LABELS.operationPending.code).toBe('MANAGED_STORAGE_OPERATION_PENDING');
    expect(STORAGE_WORKLOAD_LABELS.operationPending.message).toBe(
      'Managed storage operation is still being reconciled'
    );
  });

  it('renders the failed() lastError with and without a detail', () => {
    expect(STORAGE_WORKLOAD_LABELS.failed('create', 'boom')).toBe('Managed storage create failed: boom');
    expect(STORAGE_WORKLOAD_LABELS.failed('create')).toBe('Managed storage create failed');
  });

  it('reproduces the operation-mismatch code/message (same code as pending, distinct text)', () => {
    expect(STORAGE_WORKLOAD_LABELS.operationMismatch.code).toBe('MANAGED_STORAGE_OPERATION_PENDING');
    expect(STORAGE_WORKLOAD_LABELS.operationMismatch.message).toBe(
      'Managed storage operation does not match its pending state'
    );
  });

  it('renders invalidLifecycle() with the required→target order', () => {
    expect(STORAGE_WORKLOAD_LABELS.invalidLifecycle('ready', 'stopped')).toEqual({
      code: 'MANAGED_STORAGE_INVALID_LIFECYCLE_STATE',
      message: 'Managed storage must be ready before it can be stopped',
    });
  });

  it('reproduces the reconciling lastError', () => {
    expect(STORAGE_WORKLOAD_LABELS.reconciling).toBe('Managed storage operation outcome is being reconciled');
  });
});
