import { describe, expect, it, vi } from 'vitest';
import type {
  CreateSucceededContext,
  DaemonWorkloadState,
  DispatchResult,
  ManagedWorkloadDispatch,
} from './managed-workload-dispatch.js';
import type { ManagedWorkloadLabels } from './managed-workload-labels.js';
import { ManagedWorkloadLifecycle } from './managed-workload-lifecycle.js';
import type {
  ManagedWorkloadStore,
  WorkloadPendingOperation,
  WorkloadRow,
  WorkloadRowPatch,
} from './managed-workload-store.js';

interface TestCredentials {
  username: string;
  password: string;
}

/** Placeholder labels: the core only forwards these into `AppError`/lastError, so their exact text is irrelevant to these tests. */
const testLabels: ManagedWorkloadLabels = {
  notFound: { code: 'TEST_WORKLOAD_NOT_FOUND', message: 'Test workload not found' },
  operationPending: { code: 'TEST_WORKLOAD_OPERATION_PENDING', message: 'Test workload operation is pending' },
  operationMismatch: {
    code: 'TEST_WORKLOAD_OPERATION_PENDING',
    message: 'Test workload operation does not match its pending state',
  },
  invalidLifecycle: (required, target) => ({
    code: 'TEST_WORKLOAD_INVALID_LIFECYCLE_STATE',
    message: `Test workload must be ${required} before it can be ${target}`,
  }),
  failed: (operation, detail) =>
    detail ? `Test workload ${operation} failed: ${detail}` : `Test workload ${operation} failed`,
  reconciling: 'Test workload operation outcome is being reconciled',
};

/**
 * Test row shape: the core only requires {@link WorkloadRow}'s fields, but
 * these tests still exercise a kind that carries published-port columns
 * (mirroring `ManagedDatabaseRow`) to prove the core never reaches into them
 * directly — only `dispatch.finalizeReady`'s patch does.
 */
interface TestRow extends WorkloadRow {
  publishedPort: number | null;
  publishedNativePort: number | null;
}

/** Builds a full `DispatchResult` (`CommandResult`) from the fields a test cares about. */
function dispatchResult(partial: Partial<DispatchResult>): DispatchResult {
  return { commandId: 'cmd', success: false, error: '', detail: '', data: Buffer.alloc(0), ...partial };
}

function makeRow(overrides: Partial<TestRow> = {}): TestRow {
  return {
    id: 'workload-1',
    nodeId: 'node-1',
    status: 'creating',
    pendingOperation: { id: 'operation_durable', action: 'create' },
    updatedById: null,
    publishedPort: null,
    publishedNativePort: null,
    ...overrides,
  };
}

/**
 * Fake {@link ManagedWorkloadStore} that echoes each write back as a settled
 * row (merging the patch), and records the settlement patches so the tests can
 * assert on how the lifecycle settled an operation.
 */
function fakeStore(row: TestRow) {
  const setStatus = vi.fn(async (_id: string, patch: WorkloadRowPatch) => ({ ...row, ...patch }) as WorkloadRow);
  const setReady = vi.fn(async (_id: string, patch: WorkloadRowPatch) => ({ ...row, ...patch }) as WorkloadRow);
  const clearPending = vi.fn(async (_id: string, patch: WorkloadRowPatch) => ({ ...row, ...patch }) as WorkloadRow);
  const claimOperation = vi.fn(
    async (_id: string, _from: string, op: WorkloadPendingOperation, patch: WorkloadRowPatch) =>
      ({ ...row, pendingOperation: op, ...patch }) as WorkloadRow
  );
  const listPending = vi.fn(async () => [row as WorkloadRow]);
  const getById = vi.fn(async () => row as WorkloadRow);
  const del = vi.fn(async () => {});
  const store: ManagedWorkloadStore = {
    getById,
    listPending,
    claimOperation,
    setStatus,
    setReady,
    clearPending,
    delete: del,
  };
  return { store, setStatus, setReady, clearPending, claimOperation, listPending, getById, del };
}

/**
 * Fake {@link ManagedWorkloadDispatch}. `sendCommand` is a spy the tests drive
 * and inspect; every other hook is a benign stub so the generic lifecycle can
 * run end to end without a real database or daemon. `renderCommandPayload`
 * echoes the row's durable operation id so the replay test can prove the same
 * id is re-sent.
 */
function fakeDispatch(options: {
  credentials: TestCredentials;
  sendCommand: ManagedWorkloadDispatch<TestRow, TestCredentials>['sendCommand'];
  parseDaemonState?: (result: DispatchResult) => DaemonWorkloadState | null;
  finalizeReady?: ManagedWorkloadDispatch<TestRow, TestCredentials>['finalizeReady'];
  onCreateSucceeded?: ManagedWorkloadDispatch<TestRow, TestCredentials>['onCreateSucceeded'];
}) {
  const emit = vi.fn();
  const dispatch: ManagedWorkloadDispatch<TestRow, TestCredentials> = {
    renderCommandPayload: vi.fn(async (row: TestRow) => JSON.stringify({ operationId: row.pendingOperation!.id })),
    sendCommand: options.sendCommand,
    parseDaemonState: options.parseDaemonState ?? (() => null),
    onCreateSucceeded:
      options.onCreateSucceeded ?? vi.fn(async (_row: TestRow, _ctx: CreateSucceededContext<TestCredentials>) => {}),
    onReady: vi.fn(async () => {}),
    auditLifecycle: vi.fn(async () => {}),
    emit,
    setEventBus: vi.fn(),
    toView: vi.fn((row: TestRow) => row),
    assertNodeReady: vi.fn(async () => {}),
    prepareReplay: vi.fn(async (row: TestRow) => row),
    readOwnerCredentials: vi.fn(() => options.credentials),
    publishFlags: vi.fn(() => ({ publishTcp: false, publishNativeTcp: false })),
    ensureDirectAccess: vi.fn(async (row: TestRow) => ({ row, credentials: options.credentials })),
    provisionDirectAccess: vi.fn(async () => {}),
    resolvePublishedPort: vi.fn(async () => null),
    resolvePublishedNativePort: vi.fn(async () => null),
    finalizeReady: options.finalizeReady ?? vi.fn(async () => ({})),
    syncStorage: vi.fn(async () => {}),
    onReconcileReady: vi.fn(async (row: TestRow) => ({
      row,
      readyPatch: { publishedPort: row.publishedPort, publishedNativePort: row.publishedNativePort },
    })),
    disposeCanonicalClient: vi.fn(async () => {}),
    deleteCanonicalConnection: vi.fn(async () => {}),
  };
  return { dispatch, emit };
}

describe('ManagedWorkloadLifecycle', () => {
  it('replays a pending operation with the SAME durable id when inspect overtakes its daemon command', async () => {
    const row = makeRow({ pendingOperation: { id: 'operation_durable', action: 'create' } });
    const sendCommand = vi.fn(
      async (_nodeId: string, action: string): Promise<DispatchResult> =>
        action === 'inspect'
          ? dispatchResult({
              success: true,
              detail: JSON.stringify({ status: 'ready', operationId: 'older-operation' }),
            })
          : dispatchResult({ success: true })
    ) as unknown as ManagedWorkloadDispatch<TestRow, TestCredentials>['sendCommand'];
    const { store } = fakeStore(row);
    const { dispatch } = fakeDispatch({
      credentials: { username: 'owner', password: 'secret' },
      sendCommand,
      // A stale operation id: the durable op is 'operation_durable', so this
      // forces the replay branch.
      parseDaemonState: () => ({ status: 'ready', operationId: 'older-operation' }),
    });
    const lifecycle = new ManagedWorkloadLifecycle<TestRow, TestCredentials>(store, dispatch, testLabels);

    await lifecycle.reconcilePendingRow(row);

    const calls = (sendCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]).toEqual(['node-1', 'inspect', 'workload-1', '', 10_000]);
    // The replay re-sends a 'create' carrying the ORIGINAL durable operation
    // id — never a freshly minted one.
    expect(calls[1]![0]).toBe('node-1');
    expect(calls[1]![1]).toBe('create');
    expect(calls[1]![3]).toContain('"operationId":"operation_durable"');
  });

  it('marks the workload errored when the create daemon command reports failure', async () => {
    const row = makeRow({ pendingOperation: { id: 'operation_durable', action: 'create' } });
    const sendCommand = vi.fn(
      async (): Promise<DispatchResult> => dispatchResult({ success: false, error: 'owner cannot create users' })
    ) as unknown as ManagedWorkloadDispatch<TestRow, TestCredentials>['sendCommand'];
    const { store, setStatus } = fakeStore(row);
    const { dispatch, emit } = fakeDispatch({
      credentials: { username: 'owner', password: 'secret' },
      sendCommand,
    });
    const lifecycle = new ManagedWorkloadLifecycle<TestRow, TestCredentials>(store, dispatch, testLabels);

    await lifecycle.dispatchCreate(row, { username: 'owner', password: 'secret' }, false, false, 'user-1');

    expect(setStatus).toHaveBeenCalledWith(
      'workload-1',
      expect.objectContaining({
        status: 'error',
        pendingOperation: null,
        lastError: expect.stringContaining('owner cannot create users'),
      })
    );
    expect(emit).toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('marks the workload errored when dispatch.onCreateSucceeded throws AFTER a successful daemon command — proves a kind-specific post-create hook failure (e.g. managed storage relay registration) flows through the SAME markError path as a daemon-reported failure, not a bare throw over an already-committed row', async () => {
    const row = makeRow({ pendingOperation: { id: 'operation_durable', action: 'create' } });
    const sendCommand = vi.fn(
      async (): Promise<DispatchResult> => dispatchResult({ success: true })
    ) as unknown as ManagedWorkloadDispatch<TestRow, TestCredentials>['sendCommand'];
    const { store, setStatus } = fakeStore(row);
    const { dispatch, emit } = fakeDispatch({
      credentials: { username: 'owner', password: 'secret' },
      sendCommand,
      onCreateSucceeded: vi.fn(async () => {
        throw new Error('relay target registration failed');
      }),
    });
    const lifecycle = new ManagedWorkloadLifecycle<TestRow, TestCredentials>(store, dispatch, testLabels);

    await lifecycle.dispatchCreate(row, { username: 'owner', password: 'secret' }, false, false, 'user-1');

    expect(setStatus).toHaveBeenCalledWith(
      'workload-1',
      expect.objectContaining({
        status: 'error',
        pendingOperation: null,
        lastError: expect.stringContaining('relay target registration failed'),
      })
    );
    expect(emit).toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('persists the readyPatch that dispatch.finalizeReady returns, without the core naming any port field', async () => {
    const row = makeRow({ pendingOperation: { id: 'operation_durable', action: 'create' } });
    const sendCommand = vi.fn(
      async (): Promise<DispatchResult> => dispatchResult({ success: true })
    ) as unknown as ManagedWorkloadDispatch<TestRow, TestCredentials>['sendCommand'];
    const { store, setReady } = fakeStore(row);
    const finalizeReady = vi.fn(async () => ({ publishedPort: 5432 })) as unknown as ManagedWorkloadDispatch<
      TestRow,
      TestCredentials
    >['finalizeReady'];
    const { dispatch } = fakeDispatch({
      credentials: { username: 'owner', password: 'secret' },
      sendCommand,
      finalizeReady,
    });
    const lifecycle = new ManagedWorkloadLifecycle<TestRow, TestCredentials>(store, dispatch, testLabels);

    await lifecycle.dispatchCreate(row, { username: 'owner', password: 'secret' }, false, false, 'user-1');

    expect(finalizeReady).toHaveBeenCalledWith(
      row,
      expect.objectContaining({ operation: 'create', publishTcp: false, publishNativeTcp: false })
    );
    expect(setReady).toHaveBeenCalledWith('workload-1', expect.objectContaining({ publishedPort: 5432 }));
  });
});
