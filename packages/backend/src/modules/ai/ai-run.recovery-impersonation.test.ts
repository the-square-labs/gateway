import { describe, expect, it, vi } from 'vitest';
import { aiConversationInputs, aiRuns, aiRunToolRounds, auditLog } from '@/db/schema/index.js';
import type { User } from '@/types.js';
import { AIRunService } from './ai-run.service.js';

const user = { id: 'user-1', isBlocked: false, scopes: [] } as unknown as User;
const createdAt = new Date('2026-09-20T10:00:00Z');

function run(status: string) {
  return {
    id: 'run-1',
    conversationId: 'conversation-1',
    userId: user.id,
    status,
    activeMessageId: 'message-1',
    createdAt,
  };
}

/**
 * Drizzle-like double: each select resolves to the next queued rows of its table
 * (then `[]`), and an audit lookup resolves to `audit` or throws it.
 */
function harness(tables: Map<unknown, unknown[][]>, audit: unknown[] | Error) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const next = (table: unknown) => {
    if (table === auditLog) {
      if (audit instanceof Error) return Promise.reject(audit);
      return Promise.resolve(audit);
    }
    return Promise.resolve(tables.get(table)?.shift() ?? []);
  };
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        let result: Promise<unknown[]> | undefined;
        const rows = () => {
          result ??= next(table);
          return result;
        };
        const builder: Record<string, unknown> = {
          where: () => builder,
          orderBy: () => builder,
          limit: () => rows(),
          // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            rows().then(resolve, reject),
        };
        return builder;
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { where: async () => undefined };
      },
    })),
  };
  const service = new AIRunService(db as never);
  const executor = (service as unknown as { executor: Record<string, (...args: unknown[]) => unknown> }).executor;
  const started = {
    run: vi.spyOn(executor, 'startRunExecution').mockImplementation(() => undefined),
    toolRound: vi.spyOn(executor, 'startToolRoundContinuation').mockImplementation(() => undefined),
    pendingInput: vi.spyOn(executor, 'startPendingInputExecution').mockImplementation(() => undefined),
  };
  return { service, updates, started };
}

const impersonationStart = [{ id: 'audit-1' }];

describe('AI run recovery after a restart and impersonation', () => {
  it('resumes a queued run when its owner was not impersonated', async () => {
    const { service, updates, started } = harness(new Map([[aiRuns, [[run('queued')], [run('queued')]]]]), []);

    await service.recoverInterruptedRuns(async () => user);

    expect(started.run).toHaveBeenCalledWith(user, 'run-1');
    expect(updates).toEqual([]);
  });

  it('fails a queued run that may have started while its owner was impersonated', async () => {
    const { service, updates, started } = harness(
      new Map([[aiRuns, [[run('queued')], [run('queued')]]]]),
      impersonationStart
    );

    await service.recoverInterruptedRuns(async () => user);

    expect(started.run).not.toHaveBeenCalled();
    expect(updates).toEqual([
      {
        table: aiRuns,
        values: expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('administrator impersonated this account'),
        }),
      },
    ]);
  });

  it('treats a failed impersonation lookup as unverified', async () => {
    const { service, updates, started } = harness(
      new Map([[aiRuns, [[run('queued')], [run('queued')]]]]),
      new Error('database unavailable')
    );

    await service.recoverInterruptedRuns(async () => user);

    expect(started.run).not.toHaveBeenCalled();
    expect(updates).toEqual([{ table: aiRuns, values: expect.objectContaining({ status: 'failed' }) }]);
  });

  it('keeps the existing message when the owner cannot be loaded', async () => {
    const { service, updates } = harness(new Map([[aiRuns, [[run('queued')], [run('queued')]]]]), []);

    await service.recoverInterruptedRuns(async () => null);

    expect(updates).toEqual([
      {
        table: aiRuns,
        values: expect.objectContaining({
          error: 'PERMISSION_DENIED: Current account access could not be verified after restart.',
        }),
      },
    ]);
  });

  it.each([
    [[], true],
    [impersonationStart, false],
  ])('continues an approved tool round only without impersonation (audit %j)', async (audit, resumed) => {
    const waiting = run('waiting_for_approval');
    const { service, started } = harness(
      new Map<unknown, unknown[][]>([
        [aiRuns, [[waiting], [waiting]]],
        [aiRunToolRounds, [[{ id: 'round-1' }]]],
      ]),
      audit
    );

    await service.recoverInterruptedRuns(async () => user);

    if (resumed) {
      expect(started.toolRound).toHaveBeenCalledWith(user, {
        conversationId: 'conversation-1',
        runId: 'run-1',
        roundId: 'round-1',
      });
    } else {
      expect(started.toolRound).not.toHaveBeenCalled();
    }
  });

  it.each([
    [[], true],
    [impersonationStart, false],
  ])('dispatches queued input only without impersonation (audit %j)', async (audit, resumed) => {
    const pending = { conversationId: 'conversation-1', userId: user.id, targetRunId: null, createdAt };
    const { service, started } = harness(new Map([[aiConversationInputs, [[pending]]]]), audit);

    await service.recoverInterruptedRuns(async () => user);

    if (resumed) expect(started.pendingInput).toHaveBeenCalledWith(user, 'conversation-1');
    else expect(started.pendingInput).not.toHaveBeenCalled();
  });
});
