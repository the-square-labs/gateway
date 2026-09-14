/**
 * The `ManagedWorkloadDispatch` seam abstracts the kind-specific daemon I/O
 * and post-daemon side-effects that the core managed-workload lifecycle
 * methods on `ManagedDatabaseService` invoke today (databases now, object
 * storage later): rendering a daemon command's payload, sending it over the
 * node RPC channel, parsing the daemon's reported workload state, syncing
 * the canonical connection record after a create/update lands, warming any
 * kind-specific caches once a workload is ready, and the audit/event/view
 * side-effects that close out a lifecycle transition.
 *
 * This mirrors the `ManagedWorkloadStore` seam's shape (see
 * `managed-workload-store.ts`): the interface here defines the contract, and
 * `DatabaseWorkloadDispatch` (in
 * `modules/databases/database-workload-dispatch.ts`) moves the verbatim
 * daemon-I/O and side-effect fragments off `ManagedDatabaseService`'s
 * lifecycle methods behind it, unchanged.
 *
 * The daemon RPC itself is intentionally NOT generalized here —
 * `DatabaseWorkloadDispatch.sendCommand` still calls
 * `NodeDispatchService.sendDockerDatabaseCommand` underneath. Generalizing
 * the Go daemon protocol to a kind-agnostic RPC is a later phase; this seam
 * only abstracts the *caller* side so `ManagedDatabaseService`'s lifecycle
 * methods stop reaching into kind-specific daemon-config builders directly.
 *
 * Scope note: not every daemon-I/O call site on `ManagedDatabaseService`
 * routes through this seam yet. Only the core lifecycle methods (create,
 * update, delete, pause/unpause, and pending-operation reconciliation) and
 * their shared completion helpers (`markReady`, `markError`,
 * `markOutcomeUnknown`, `completeLifecycleTransition`, `completeDelete`) were
 * moved. Auxiliary daemon calls that are shared with lifecycle-unrelated
 * callers — `resolvePublishedPort`/`resolvePublishedNativePort`'s inspect
 * fallback (also exercised directly by a unit test), the direct-access
 * principal RPC (`provisionDirectAccessPrincipal`, also used by
 * `revealCredentials`/`rotateDirectAccessCredentials`), and `restart`'s own
 * daemon dispatch — stay on `ManagedDatabaseService` for this task, to avoid
 * duplicating logic that other non-lifecycle call sites also depend on.
 */

import type { CommandResult } from '@/grpc/generated/types.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { WorkloadRowPatch } from './managed-workload-store.js';

/** The daemon RPC's response shape, kept identical to `CommandResult` under a seam-neutral name. */
export type DispatchResult = CommandResult;

/** A pending long-running operation, as read off a workload row (mirrors `WorkloadPendingOperation`). */
export interface DispatchPendingOperation {
  id: string;
  action: string;
}

/** The lifecycle-relevant slice of a workload row this seam's methods need. */
export interface DispatchWorkloadRow {
  id: string;
  nodeId: string;
  pendingOperation: DispatchPendingOperation | null;
}

/** A workload's daemon-reported state, parsed from a `DispatchResult`'s detail JSON. */
export interface DaemonWorkloadState {
  status: 'ready' | 'paused' | 'stopped' | 'missing';
  operationId?: string;
}

/**
 * Inputs for `onCreateSucceeded`'s canonical-connection sync (the "connection
 * sync" step of the current post-create/post-update block). Direct-access
 * principal provisioning and published-port resolution stay on
 * `ManagedDatabaseService` — see this file's module doc for why — so this
 * context only carries what the sync step itself needs.
 */
export interface CreateSucceededContext<TCredentials> {
  credentials: TCredentials;
  userId: string | null;
}

/**
 * A dispatch that knows how to talk to one kind of managed workload's daemon
 * and carry out its kind-specific post-daemon side-effects, on top of
 * whatever node-RPC channel and supporting services back it.
 */
export interface ManagedWorkloadDispatch<
  TRow extends DispatchWorkloadRow = DispatchWorkloadRow,
  TCredentials = unknown,
> {
  beforeDelete?(row: TRow, userId: string | null): Promise<void>;
  commitDelete?(row: TRow): Promise<void>;

  /**
   * Renders the JSON payload for a daemon command against `row`. For
   * `'create'`/`'update'`/`'restart'`, wraps the kind's daemon-config builder
   * (e.g. `daemonCreateConfig`); for every other action, wraps
   * `{ operationId: row.pendingOperation.id }`.
   */
  renderCommandPayload(row: TRow, action: string): Promise<string>;

  /**
   * Asserts the workload's node is present, of the right kind, and online
   * before a lifecycle transition claims an operation on it. Relocated from
   * `ManagedDatabaseService.assertDatabaseNode` (the value it returned is
   * unused by every lifecycle-core caller, so this hook is `void`).
   */
  assertNodeReady(nodeId: string): Promise<void>;

  /**
   * Refreshes the kind-specific certificate before a pending operation is
   * replayed, returning the (possibly updated) row. Relocated from
   * `replayPendingOperation`'s `if (this.databaseCA) { node =
   * assertDatabaseNode(...); row = ensureCertificate(row, node); }` head — a
   * no-op that returns `row` unchanged for kinds without a CA.
   */
  prepareReplay(row: TRow): Promise<TRow>;

  /** Decrypts a row's owner credentials (relocated from the service's `ownerCredentials`). */
  readOwnerCredentials(row: TRow): TCredentials;

  /** The kind's publish flags for a row (relocated from `managedDatabasePublish{Tcp,NativeTcp}`). */
  publishFlags(row: TRow): { publishTcp: boolean; publishNativeTcp: boolean };

  /**
   * Ensures a direct-access principal/credentials exist for `row`, returning
   * the (possibly updated) row and its credentials. Relocated from
   * `ManagedDatabaseService.ensureDirectAccessCredentials`; `provision`
   * controls whether the daemon principal is (re)applied as a side effect.
   */
  ensureDirectAccess(
    row: TRow,
    userId: string | null,
    provision: boolean
  ): Promise<{ row: TRow; credentials: TCredentials }>;

  /**
   * Applies a direct-access principal on the daemon (relocated from
   * `ManagedDatabaseService.provisionDirectAccessPrincipal`).
   */
  provisionDirectAccess(row: TRow, owner: TCredentials, credentials: TCredentials): Promise<void>;

  /**
   * Applies whatever principals the kind needs after a successful create or
   * update, returning the row to carry forward.
   *
   * The generic lifecycle cannot make this call itself: ClickHouse replaces
   * the direct-access principal with a reader/writer pair and updates the row
   * while doing so, whereas other kinds only apply a direct-access principal
   * and leave the row untouched. Kinds without either concept can omit this
   * and get the default behaviour below.
   */
  /**
   * Lets the owning service inject the principal flow when it holds state the
   * dispatch deliberately does not (credential decryption, readiness markers).
   */
  setPrincipalProvisioner?(provisioner: (row: TRow, userId: string | null) => Promise<TRow>): void;

  applyPrincipals?(
    row: TRow,
    direct: { row: TRow; credentials: TCredentials } | null,
    owner: TCredentials,
    userId: string | null
  ): Promise<TRow>;

  /**
   * Resolves the published TCP port after a create/update daemon command,
   * inspecting the daemon record when the command detail omitted it. Relocated
   * from `ManagedDatabaseService.resolvePublishedPort`.
   */
  resolvePublishedPort(row: TRow, publishTcp: boolean, result: { detail?: string }): Promise<number | null>;

  /** As {@link resolvePublishedPort}, for a kind's native TCP port (relocated from `resolvePublishedNativePort`). */
  resolvePublishedNativePort(row: TRow, publishNativeTcp: boolean, result: { detail?: string }): Promise<number | null>;

  /**
   * Returns the kind-specific columns to persist when a workload settles into
   * a ready state after `operation`. For `'create'`/`'update'` this resolves
   * the published TCP/native-TCP ports (wrapping {@link resolvePublishedPort}/
   * {@link resolvePublishedNativePort}); for `'restart'` the row's existing
   * ports are reused verbatim rather than re-resolved, since a restart never
   * changes which host port a workload is published on. The core threads the
   * returned patch straight into the store's ready write without naming any
   * of its fields.
   */
  finalizeReady(
    row: TRow,
    ctx: {
      operation: 'create' | 'update' | 'restart';
      publishTcp: boolean;
      publishNativeTcp: boolean;
      result: { detail?: string };
    }
  ): Promise<WorkloadRowPatch>;

  /**
   * Syncs the canonical connection's storage accounting after an update lands.
   * Relocated from `dispatchUpdate`'s post-`setReady`
   * `provider.syncCanonicalConnection({ ..., storageSizeBytes })` step.
   */
  syncStorage(row: TRow): Promise<void>;

  /**
   * Reconciliation counterpart of the post-create/update side-effects:
   * (re)applies the direct-access principal when the kind publishes, resyncs
   * the canonical owner connection, and resolves the recovered published port.
   * Relocated from `reconcilePendingRow`'s ready tail; returns the current row
   * and the kind-specific patch to settle with.
   */
  onReconcileReady(row: TRow, result: { detail?: string }): Promise<{ row: TRow; readyPatch: WorkloadRowPatch }>;

  /**
   * Disposes any pooled client for the canonical connection before the row is
   * deleted (relocated from `completeDelete`'s
   * `databaseConnectionService.disposeClient`).
   */
  disposeCanonicalClient(row: TRow): Promise<void>;

  /**
   * Deletes the canonical connection record after the workload row is deleted
   * (relocated from `completeDelete`'s `db.delete(databaseConnections)`).
   */
  deleteCanonicalConnection(row: TRow): Promise<void>;

  /** Sends a rendered command to the workload's node over the daemon RPC channel. */
  sendCommand(nodeId: string, action: string, id: string, payload: string, timeoutMs?: number): Promise<DispatchResult>;

  /** Parses a daemon response's reported workload state, or `null` when it can't be parsed. */
  parseDaemonState(result: DispatchResult): DaemonWorkloadState | null;

  /** Syncs the canonical connection record after a create/update daemon command succeeds. */
  onCreateSucceeded(row: TRow, ctx: CreateSucceededContext<TCredentials>): Promise<void>;

  /** Warms any kind-specific caches once a workload reaches a ready state (a no-op for kinds without one). */
  onReady(row: TRow): Promise<void>;

  /** Records a lifecycle audit-log entry for `action` against `row`. */
  auditLifecycle(action: string, row: TRow, userId: string | null): Promise<void>;

  /** Publishes a workload-changed event. */
  emit(row: TRow, event: string): void;

  /** Sets the event bus `emit` publishes through (mirrors the service-level `setEventBus` convention). */
  setEventBus(bus: EventBusService): void;

  /** Builds the safe, client-facing view of a workload row. */
  toView(row: TRow): unknown;
}
