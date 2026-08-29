export interface ManagedDatabaseBindingLifecycleSnapshot {
  desiredState: 'active' | 'deleted';
}

export interface ManagedDatabaseBindingLifecycleActions<TBinding> {
  markDeleting(): Promise<TBinding>;
  revokeAccess(binding: TBinding): Promise<void>;
  deprovision(binding: TBinding): Promise<void>;
  deleteRecord(binding: TBinding): Promise<void>;
  ensurePrincipal(binding: TBinding): Promise<TBinding>;
  markPrincipalReady(binding: TBinding): Promise<TBinding>;
  ensureRuntime(binding: TBinding): Promise<void>;
  markReady(binding: TBinding): Promise<TBinding>;
}

export type ManagedDatabaseBindingLifecycleResult<TBinding> =
  | { deleted: true }
  | { deleted: false; binding: TBinding };

/**
 * Monotonic binding lifecycle. The persisted desired state is authoritative;
 * task records and in-memory transitions are diagnostics only.
 */
export async function reconcileManagedDatabaseBindingLifecycle<TBinding>(
  snapshot: ManagedDatabaseBindingLifecycleSnapshot,
  initialBinding: TBinding,
  actions: ManagedDatabaseBindingLifecycleActions<TBinding>
): Promise<ManagedDatabaseBindingLifecycleResult<TBinding>> {
  if (snapshot.desiredState === 'deleted') {
    const deleting = await actions.markDeleting();
    await actions.revokeAccess(deleting);
    await actions.deprovision(deleting);
    await actions.deleteRecord(deleting);
    return { deleted: true };
  }

  let current = await actions.ensurePrincipal(initialBinding);
  current = await actions.markPrincipalReady(current);
  await actions.ensureRuntime(current);
  current = await actions.markReady(current);
  return { deleted: false, binding: current };
}
