import { describe, expect, it, vi } from 'vitest';
import type { AIPlan } from '@/db/schema/index.js';
import { AIPlanService } from './ai-plan.service.js';

function planRow(overrides: Partial<AIPlan> = {}): AIPlan {
  const now = new Date('2026-08-12T00:00:00.000Z');
  return {
    id: 'plan-1',
    conversationId: 'conversation-1',
    userId: 'user-1',
    status: 'executing',
    title: 'Plan',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    noProgressRuns: 0,
    progressVersion: 0,
    activeTimeMs: 0,
    activeSince: now,
    pauseReason: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queuedSelectDb(selectRows: unknown[][]) {
  const queue = [...selectRows];
  const select = vi.fn(() => {
    const rows = queue.shift() ?? [];
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async () => rows),
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are PromiseLike.
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  });
  return { select, update: vi.fn(), insert: vi.fn(), transaction: vi.fn() };
}

describe('AIPlanService lifecycle guards', () => {
  it('returns every conversation plan in timeline order', async () => {
    const first = planRow({ id: 'plan-1', createdAt: new Date('2026-08-12T00:00:00.000Z') });
    const second = planRow({ id: 'plan-2', createdAt: new Date('2026-08-12T00:10:00.000Z') });
    const db = queuedSelectDb([
      [first, second],
      [
        {
          id: 'revision-1',
          planId: 'plan-1',
          revision: 1,
          status: 'accepted',
          publishedAt: new Date('2026-08-12T00:01:00.000Z'),
          acceptedAt: new Date('2026-08-12T00:02:00.000Z'),
        },
      ],
      [{ publishedAt: new Date('2026-08-12T00:01:00.000Z') }],
      [],
      [
        {
          id: 'revision-2',
          planId: 'plan-2',
          revision: 1,
          status: 'accepted',
          publishedAt: new Date('2026-08-12T00:11:00.000Z'),
          acceptedAt: new Date('2026-08-12T00:12:00.000Z'),
        },
      ],
      [{ publishedAt: new Date('2026-08-12T00:11:00.000Z') }],
      [],
    ]);

    const plans = await new AIPlanService(db as never).listPlanSnapshots('user-1', 'conversation-1');

    expect(plans.map((plan) => plan.id)).toEqual(['plan-1', 'plan-2']);
    expect(plans.map((plan) => plan.timelineAnchorAt)).toEqual([
      '2026-08-12T00:01:00.000Z',
      '2026-08-12T00:11:00.000Z',
    ]);
  });

  it('keeps an unverified refinement out of the published timeline snapshot', async () => {
    const refiningPlan = planRow({ status: 'validating' });
    const firstPublishedAt = new Date('2026-08-12T00:01:00.000Z');
    const db = queuedSelectDb([
      [refiningPlan],
      [
        {
          id: 'revision-1',
          planId: 'plan-1',
          revision: 1,
          status: 'superseded',
          goal: 'Previously verified plan',
          publishedAt: firstPublishedAt,
        },
      ],
      [{ publishedAt: firstPublishedAt }],
      [],
      [refiningPlan],
      [
        {
          id: 'revision-2',
          planId: 'plan-1',
          revision: 2,
          status: 'validating',
          goal: 'Unverified refinement',
          publishedAt: null,
        },
      ],
      [{ publishedAt: firstPublishedAt }],
      [],
    ]);
    const service = new AIPlanService(db as never);

    const [timelinePlan] = await service.listPlanSnapshots('user-1', 'conversation-1');
    const runtimePlan = await service.getLatestPlanSnapshot('user-1', 'conversation-1');

    expect(timelinePlan).toMatchObject({ revisionId: 'revision-1', goal: 'Previously verified plan' });
    expect(runtimePlan).toMatchObject({ revisionId: 'revision-2', goal: 'Unverified refinement' });
  });

  it('returns a technically failed validation to drafting without counting it as a rejected review', async () => {
    const validating = planRow({ status: 'validating' });
    const db = queuedSelectDb([[validating]]);
    const updates: unknown[] = [];
    const updateChain = {
      set: vi.fn((value: unknown) => {
        updates.push(value);
        return updateChain;
      }),
      where: vi.fn(async () => []),
    };
    db.update = vi.fn(() => updateChain) as never;
    db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db)) as never;

    await expect(
      new AIPlanService(db as never).recoverFailedValidation(
        'user-1',
        'conversation-1',
        'plan-1',
        'Provider unavailable'
      )
    ).resolves.toBe(true);

    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'superseded', validatorFindings: ['Provider unavailable'] })
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'drafting', pauseReason: 'Provider unavailable' })
    );
  });

  it('requires evidence before a step can be completed', async () => {
    const service = new AIPlanService(queuedSelectDb([[planRow()]]) as never);

    await expect(
      service.updateStep({
        userId: 'user-1',
        conversationId: 'conversation-1',
        stepId: 'step-1',
        status: 'completed',
      })
    ).rejects.toMatchObject({ code: 'AI_PLAN_STEP_EVIDENCE_REQUIRED' });
  });

  it('requires a reason before a step can be skipped', async () => {
    const service = new AIPlanService(queuedSelectDb([[planRow()]]) as never);

    await expect(
      service.updateStep({
        userId: 'user-1',
        conversationId: 'conversation-1',
        stepId: 'step-1',
        status: 'skipped',
      })
    ).rejects.toMatchObject({ code: 'AI_PLAN_STEP_SKIP_REASON_REQUIRED' });
  });

  it('does not enter final verification while implementation steps remain incomplete', async () => {
    const service = new AIPlanService(
      queuedSelectDb([
        [planRow()],
        [{ id: 'revision-1', planId: 'plan-1', status: 'accepted', revision: 1 }],
        [{ id: 'step-1', status: 'pending', skipReason: null }],
      ]) as never
    );

    await expect(service.requestFinalVerification('user-1', 'conversation-1')).rejects.toMatchObject({
      code: 'AI_PLAN_INCOMPLETE',
    });
  });

  it('resumes a paused final-verification run back into verification', async () => {
    const paused = planRow({ status: 'paused', activeSince: null });
    const verifying = planRow({ status: 'verifying', activeSince: new Date('2026-08-12T00:03:00.000Z') });
    const db = queuedSelectDb([[paused], [{ purpose: 'plan_verification' }], [verifying], []]);
    const set = vi.fn();
    const updateChain = {
      set: vi.fn((value: unknown) => {
        set(value);
        return updateChain;
      }),
      where: vi.fn(async () => []),
    };
    db.update = vi.fn(() => updateChain) as never;

    const result = await new AIPlanService(db as never).resume('user-1', 'conversation-1');

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'verifying', pauseReason: null }));
    expect(result.status).toBe('verifying');
  });

  it('keeps a passed final verification active until the AI run ends', async () => {
    const verifying = planRow({ status: 'verifying' });
    const persisted = planRow({ status: 'verifying', pauseReason: 'Everything is verified' });
    const db = queuedSelectDb([
      [verifying],
      [persisted],
      [
        {
          id: 'revision-1',
          planId: 'plan-1',
          status: 'accepted',
          revision: 1,
          publishedAt: new Date('2026-08-12T00:01:00.000Z'),
          acceptedAt: new Date('2026-08-12T00:02:00.000Z'),
        },
      ],
      [{ publishedAt: new Date('2026-08-12T00:01:00.000Z') }],
      [],
    ]);
    const set = vi.fn();
    const updateChain = {
      set: vi.fn((value: unknown) => {
        set(value);
        return updateChain;
      }),
      where: vi.fn(async () => []),
    };
    db.update = vi.fn(() => updateChain) as never;

    const result = await new AIPlanService(db as never).submitFinalVerification({
      userId: 'user-1',
      conversationId: 'conversation-1',
      planId: 'plan-1',
      verdict: 'pass',
      summary: 'Everything is verified',
      findings: [],
    });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ pauseReason: 'Everything is verified' }));
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(result.status).toBe('verifying');
    expect(result.completionPending).toBe(true);
    expect(result.timelineAnchorAt).toBe('2026-08-12T00:01:00.000Z');
  });

  it('marks final verification complete only after its AI run ends', async () => {
    const verifying = planRow({ status: 'verifying' });
    const completed = planRow({ status: 'completed', activeSince: null, completedAt: new Date() });
    const db = queuedSelectDb([
      [verifying],
      [completed],
      [
        {
          id: 'revision-1',
          planId: 'plan-1',
          status: 'accepted',
          revision: 1,
          publishedAt: new Date('2026-08-12T00:01:00.000Z'),
          acceptedAt: new Date('2026-08-12T00:02:00.000Z'),
        },
      ],
      [{ publishedAt: new Date('2026-08-12T00:01:00.000Z') }],
      [],
    ]);
    const set = vi.fn();
    const updateChain = {
      set: vi.fn((value: unknown) => {
        set(value);
        return updateChain;
      }),
      where: vi.fn(async () => []),
    };
    db.update = vi.fn(() => updateChain) as never;

    const result = await new AIPlanService(db as never).completeFinalVerificationAfterRun('user-1', 'conversation-1');

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(result.status).toBe('completed');
  });
});
