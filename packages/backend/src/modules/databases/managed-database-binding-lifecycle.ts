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
  | {
      deleted: true;
    }
  | {
      deleted: false;
      binding: TBinding;
    };
export declare function reconcileManagedDatabaseBindingLifecycle<TBinding>(
  snapshot: ManagedDatabaseBindingLifecycleSnapshot,
  initialBinding: TBinding,
  actions: ManagedDatabaseBindingLifecycleActions<TBinding>
): Promise<ManagedDatabaseBindingLifecycleResult<TBinding>>;
