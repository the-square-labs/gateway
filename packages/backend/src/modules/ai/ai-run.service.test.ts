import { describe, expect, it, vi } from 'vitest';
import type { AIRun } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { AIRunService } from './ai-run.service.js';

function createTransitionDb<T>(updateRows: T[], selectRows: unknown[][] = [[{ id: 'conversation-1' }]]) {
  const selectQueue = [...selectRows];
  const returning = vi.fn().mockResolvedValue(updateRows);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const orderBy = vi.fn(async () => selectQueue.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const tx = { update, select };
  const transaction = vi.fn((callback: (txArg: typeof tx) => unknown) => callback(tx));

  return {
    db: { update, select, transaction },
    transaction,
    returning,
    updateWhere,
    set,
    update,
    limit,
    selectWhere,
    from,
    select,
  };
}

function createStopActiveRunDb<T>(updateRows: T[], selectRows: unknown[][]) {
  const selectQueue = [...selectRows];
  const returning = vi.fn().mockResolvedValue(updateRows);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const orderBy = vi.fn(() => ({ limit }));
  const selectWhere = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  return {
    db: { update, select },
    returning,
    updateWhere,
    set,
    update,
    limit,
    selectWhere,
    from,
    select,
  };
}

function createStartRunDb({ selectRows, insertRows = [] }: { selectRows: unknown[][]; insertRows?: unknown[][] }) {
  const selectQueue = [...selectRows];
  const insertQueue = [...insertRows];

  const selectLimit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
  const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturning = vi.fn(async () => insertQueue.shift() ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const tx = { select, insert, update };
  const transaction = vi.fn((callback: (txArg: typeof tx) => unknown) => callback(tx));
  return {
    db: { select, insert, update, transaction },
    tx,
    select,
    insert,
    insertValues,
    update,
    updateSet,
    transaction,
  };
}

function createRuntimeSnapshotDb() {
  let whereCall = 0;
  const orderByQuestions = vi.fn(async () => []);
  const where = vi.fn(() => {
    whereCall += 1;
    return whereCall === 1 || whereCall === 3 || whereCall === 4 || whereCall === 5
      ? { orderBy: orderByQuestions }
      : Promise.resolve([]);
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

describe('AIRunService plan completion', () => {
  it('does not count a non-terminal step update as execution progress', async () => {
    const where = vi.fn().mockResolvedValue([{ status: 'completed', result: { progressMade: false } }]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const planService = {
      getActivePlanSnapshot: vi.fn().mockResolvedValue({ status: 'executing' }),
      recordExecutionRunOutcome: vi.fn().mockResolvedValue({ status: 'paused' }),
    };
    const service = new AIRunService({ select } as never, undefined, undefined, planService as never);

    await (
      service as unknown as {
        handleCompletedRun: (user: { id: string }, run: unknown) => Promise<boolean>;
      }
    ).handleCompletedRun(
      { id: 'user-1' },
      { id: 'run-1', conversationId: 'conversation-1', purpose: 'plan_execution' }
    );

    expect(planService.recordExecutionRunOutcome).toHaveBeenCalledWith('user-1', 'conversation-1', false);
  });

  it('completes a verified plan only after the verification run is done', async () => {
    const where = vi.fn().mockResolvedValue([{ status: 'completed' }]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const planService = {
      getActivePlanSnapshot: vi.fn().mockResolvedValue({ status: 'verifying' }),
      completeFinalVerificationAfterRun: vi.fn().mockResolvedValue({ status: 'completed' }),
    };
    const service = new AIRunService({ select } as never, undefined, undefined, planService as never);

    const handled = await (
      service as unknown as {
        handleCompletedRun: (user: { id: string }, run: unknown) => Promise<boolean>;
      }
    ).handleCompletedRun(
      { id: 'user-1' },
      { id: 'run-1', conversationId: 'conversation-1', purpose: 'plan_verification' }
    );

    expect(handled).toBe(true);
    expect(planService.completeFinalVerificationAfterRun).toHaveBeenCalledWith('user-1', 'conversation-1');
  });
});

describe('AIRunService startUserRun', () => {
  it('creates a conversation, user message, and queued run atomically', async () => {
    const conversation = {
      id: 'conversation-1',
      lastContext: null,
      model: 'model-a',
      reasoningEffort: 'high',
    };
    const message = { id: 'message-1' };
    const run = {
      id: 'run-1',
      conversationId: 'conversation-1',
      activeMessageId: 'message-1',
      clientCommandId: 'cmd-1',
      status: 'queued',
    };
    const harness = createStartRunDb({
      selectRows: [[], [], []],
      insertRows: [[conversation], [message], [run]],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        userId: 'user-1',
        title: '  New chat  ',
        userMessage: { role: 'user', content: 'hello' },
        clientCommandId: 'cmd-1',
        lastContext: { route: '/nodes' },
        model: 'model-a',
        reasoningEffort: 'high',
      })
    ).resolves.toEqual({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: false,
    });

    expect(harness.transaction).toHaveBeenCalled();
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        title: 'New chat',
        lastContext: { route: '/nodes' },
        model: 'model-a',
        reasoningEffort: 'high',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        sequence: 0,
        role: 'user',
        content: 'hello',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        userId: 'user-1',
        clientCommandId: 'cmd-1',
        activeMessageId: 'message-1',
        model: 'model-a',
        reasoningEffort: 'high',
        status: 'queued',
      })
    );
  });

  it('appends a new user turn after the existing conversation history', async () => {
    const conversation = {
      id: 'conversation-1',
      lastContext: null,
      model: 'pinned-model',
      reasoningEffort: null,
    };
    const message = { id: 'message-2' };
    const run = {
      id: 'run-2',
      conversationId: 'conversation-1',
      activeMessageId: 'message-2',
      clientCommandId: 'cmd-2',
      status: 'queued',
    };
    const harness = createStartRunDb({
      selectRows: [[], [conversation], [], [], [], [{ sequence: 4 }]],
      insertRows: [[message], [run]],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        title: 'Existing chat',
        userMessage: { role: 'user', content: 'follow up' },
        clientCommandId: 'cmd-2',
        model: 'stale-client-model',
        reasoningEffort: 'high',
      })
    ).resolves.toEqual({
      conversationId: 'conversation-1',
      userMessageId: 'message-2',
      run,
      duplicate: false,
    });

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        sequence: 5,
        role: 'user',
        content: 'follow up',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        model: 'pinned-model',
        reasoningEffort: null,
        status: 'queued',
      })
    );
  });

  it('returns an existing run for a repeated command without creating another transaction', async () => {
    const run = {
      id: 'run-1',
      conversationId: 'conversation-1',
      activeMessageId: 'message-1',
      clientCommandId: 'cmd-1',
      status: 'queued',
    };
    const harness = createStartRunDb({ selectRows: [[run]] });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        title: 'Existing chat',
        userMessage: { role: 'user', content: 'hello' },
        clientCommandId: 'cmd-1',
      })
    ).resolves.toEqual({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: true,
    });

    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('deduplicates a repeated new-conversation command before the conversation id is known', async () => {
    const run = {
      id: 'run-1',
      conversationId: 'conversation-1',
      activeMessageId: 'message-1',
      clientCommandId: 'cmd-1',
      status: 'queued',
    };
    const harness = createStartRunDb({ selectRows: [[run]] });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        userId: 'user-1',
        title: 'New chat',
        userMessage: { role: 'user', content: 'hello' },
        clientCommandId: 'cmd-1',
      })
    ).resolves.toEqual({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: true,
    });

    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('rejects a new message when the conversation already has an active run', async () => {
    const conversation = { id: 'conversation-1', lastContext: null };
    const activeRun = { id: 'run-active', status: 'running' };
    const harness = createStartRunDb({
      selectRows: [[], [conversation], [], [], [activeRun]],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        title: 'Existing chat',
        userMessage: { role: 'user', content: 'hello' },
        clientCommandId: 'cmd-2',
      })
    ).rejects.toMatchObject({
      code: 'AI_RUN_ACTIVE',
      statusCode: 409,
    });

    expect(harness.insert).not.toHaveBeenCalled();
  });

  it('rejects a new message when the conversation has ended', async () => {
    const conversation = { id: 'conversation-1', lastContext: null };
    const harness = createStartRunDb({
      selectRows: [
        [],
        [conversation],
        [],
        [
          {
            uiMessage: {
              role: 'assistant',
              content: '',
              conversationStatus: 'ended',
              blockReason: 'I can only help with Gateway infrastructure.',
            },
          },
        ],
      ],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        title: 'Existing chat',
        userMessage: { role: 'user', content: 'hello' },
        clientCommandId: 'cmd-2',
      })
    ).rejects.toMatchObject({
      code: 'AI_CONVERSATION_ENDED',
      statusCode: 409,
    });

    expect(harness.insert).not.toHaveBeenCalled();
  });

  it('rejects a new message when the conversation is context-blocked', async () => {
    const conversation = { id: 'conversation-1', lastContext: null };
    const harness = createStartRunDb({
      selectRows: [
        [],
        [conversation],
        [],
        [
          {
            uiMessage: {
              role: 'assistant',
              content: '',
              conversationStatus: 'context_blocked',
              blockReason: 'Context limit reached. Start a new chat to continue.',
            },
          },
        ],
      ],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startUserRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        title: 'Existing chat',
        userMessage: { role: 'user', content: 'hello' },
        clientCommandId: 'cmd-2',
      })
    ).rejects.toMatchObject({
      code: 'AI_CONVERSATION_CONTEXT_BLOCKED',
      statusCode: 409,
    });

    expect(harness.insert).not.toHaveBeenCalled();
  });
});

describe('AIRunService startContinuationRun', () => {
  it('creates a queued continuation after a stopped run without inserting another user message', async () => {
    const conversation = {
      id: 'conversation-1',
      lastContext: { route: '/nodes' },
      model: 'pinned-model',
      reasoningEffort: 'low',
    };
    const run = {
      id: 'run-2',
      conversationId: 'conversation-1',
      activeMessageId: 'message-1',
      clientCommandId: 'continue:cmd-continue',
      status: 'queued',
    };
    const harness = createStartRunDb({
      selectRows: [[], [conversation], [], [], [], [{ status: 'stopped' }], [{ id: 'message-1' }]],
      insertRows: [[run]],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startContinuationRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        clientCommandId: 'cmd-continue',
        lastContext: { route: '/docker/containers' },
      })
    ).resolves.toEqual({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: false,
    });

    expect(harness.insert).toHaveBeenCalledTimes(1);
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCommandId: 'continue:cmd-continue',
        activeMessageId: 'message-1',
        model: 'pinned-model',
        reasoningEffort: 'low',
        status: 'queued',
      })
    );
  });

  it('rejects continuation when the previous run completed normally', async () => {
    const harness = createStartRunDb({
      selectRows: [
        [],
        [{ id: 'conversation-1', lastContext: null, model: null, reasoningEffort: null }],
        [],
        [],
        [],
        [{ status: 'completed' }],
      ],
    });
    const service = new AIRunService(harness.db as never);

    await expect(
      service.startContinuationRun({
        conversationId: 'conversation-1',
        userId: 'user-1',
        clientCommandId: 'cmd-continue',
      })
    ).rejects.toMatchObject({
      code: 'AI_CONTINUATION_UNAVAILABLE',
      statusCode: 409,
    });

    expect(harness.insert).not.toHaveBeenCalled();
  });
});

describe('AIRunService tool approval decisions', () => {
  it('keeps a durable round gated while its credential challenge is pending', async () => {
    const rows = [[{ status: 'approved' }], [], [{ id: 'credential-1' }]];
    const where = vi.fn(async () => rows.shift() ?? []);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    const service = new AIRunService({ select, update: vi.fn(() => ({ set })) } as never);

    await expect(
      (
        service as unknown as {
          markRoundReadyIfUngated(db: unknown, roundId: string): Promise<boolean>;
        }
      ).markRoundReadyIfUngated({ select, update: vi.fn(() => ({ set })) }, 'round-1')
    ).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'executing' }));
  });

  it('atomically approves a pending tool call', async () => {
    const approved = {
      id: 'tool-1',
      status: 'approved',
      decision: 'approved',
      decisionClientCommandId: 'cmd-1',
    };
    const harness = createTransitionDb([approved]);
    const service = new AIRunService(harness.db as never);

    await expect(
      service.decideToolCall({
        conversationId: 'conversation-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        userId: 'user-1',
        clientCommandId: 'cmd-1',
        decision: 'approved',
      })
    ).resolves.toEqual({ toolCall: approved, duplicate: false, continuationReady: true });

    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        decision: 'approved',
        decisionUserId: 'user-1',
        decisionClientCommandId: 'cmd-1',
        decisionAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(harness.select).toHaveBeenCalled();
  });

  it('treats a repeated identical tool decision as idempotent', async () => {
    const existing = {
      id: 'tool-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'approved',
      decision: 'approved',
      decisionClientCommandId: 'cmd-1',
    };
    const harness = createTransitionDb([], [[{ id: 'conversation-1' }], [existing], []]);
    const service = new AIRunService(harness.db as never);

    await expect(
      service.decideToolCall({
        conversationId: 'conversation-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        userId: 'user-1',
        clientCommandId: 'cmd-1',
        decision: 'approved',
      })
    ).resolves.toEqual({ toolCall: existing, duplicate: true, continuationReady: true });
  });

  it('rejects conflicting tool decisions', async () => {
    const harness = createTransitionDb(
      [],
      [
        [{ id: 'conversation-1' }],
        [
          {
            id: 'tool-1',
            runId: 'run-1',
            conversationId: 'conversation-1',
            status: 'approved',
            decision: 'approved',
            decisionClientCommandId: 'cmd-1',
          },
        ],
      ]
    );
    const service = new AIRunService(harness.db as never);

    const decision = service.decideToolCall({
      conversationId: 'conversation-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      userId: 'user-1',
      clientCommandId: 'cmd-2',
      decision: 'rejected',
    });

    await expect(decision).rejects.toBeInstanceOf(AppError);
    await expect(decision).rejects.toMatchObject({
      code: 'AI_TOOL_CALL_DECISION_CONFLICT',
      statusCode: 409,
    });
  });
});

describe('AIRunService question answers', () => {
  it('atomically answers a pending question', async () => {
    const answered = {
      id: 'question-1',
      status: 'answered',
      answer: 'Use production',
      answerClientCommandId: 'cmd-1',
    };
    const harness = createTransitionDb([answered]);
    const service = new AIRunService(harness.db as never);

    await expect(
      service.answerQuestion({
        conversationId: 'conversation-1',
        runId: 'run-1',
        questionId: 'question-1',
        userId: 'user-1',
        clientCommandId: 'cmd-1',
        answer: 'Use production',
      })
    ).resolves.toEqual({
      question: answered,
      duplicate: false,
      remainingPendingQuestions: [],
      continuationReady: true,
    });

    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'answered',
        answer: 'Use production',
        answerUserId: 'user-1',
        answerClientCommandId: 'cmd-1',
        answeredAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(harness.select).toHaveBeenCalled();
  });

  it('treats a repeated identical answer as idempotent', async () => {
    const existing = {
      id: 'question-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'answered',
      answer: 'Use production',
      answerClientCommandId: 'cmd-1',
    };
    const harness = createTransitionDb([], [[{ id: 'conversation-1' }], [existing]]);
    const service = new AIRunService(harness.db as never);

    await expect(
      service.answerQuestion({
        conversationId: 'conversation-1',
        runId: 'run-1',
        questionId: 'question-1',
        userId: 'user-1',
        clientCommandId: 'cmd-1',
        answer: 'Use production',
      })
    ).resolves.toEqual({
      question: existing,
      duplicate: true,
      remainingPendingQuestions: [],
      continuationReady: true,
    });
  });

  it('treats original tool call ids as valid question ids', async () => {
    const existing = {
      id: 'question-1',
      toolCallId: 'call_question_1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'answered',
      answer: 'Use production',
      answerClientCommandId: 'cmd-1',
    };
    const harness = createTransitionDb([], [[{ id: 'conversation-1' }], [existing]]);
    const service = new AIRunService(harness.db as never);

    await expect(
      service.answerQuestion({
        conversationId: 'conversation-1',
        runId: 'run-1',
        questionId: 'call_question_1',
        userId: 'user-1',
        clientCommandId: 'cmd-1',
        answer: 'Use production',
      })
    ).resolves.toEqual({
      question: existing,
      duplicate: true,
      remainingPendingQuestions: [],
      continuationReady: true,
    });
  });

  it('rejects conflicting answers', async () => {
    const harness = createTransitionDb(
      [],
      [
        [{ id: 'conversation-1' }],
        [
          {
            id: 'question-1',
            runId: 'run-1',
            conversationId: 'conversation-1',
            status: 'answered',
            answer: 'Use production',
            answerClientCommandId: 'cmd-1',
          },
        ],
      ]
    );
    const service = new AIRunService(harness.db as never);

    const answer = service.answerQuestion({
      conversationId: 'conversation-1',
      runId: 'run-1',
      questionId: 'question-1',
      userId: 'user-1',
      clientCommandId: 'cmd-2',
      answer: 'Use staging',
    });

    await expect(answer).rejects.toBeInstanceOf(AppError);
    await expect(answer).rejects.toMatchObject({
      code: 'AI_QUESTION_ANSWER_CONFLICT',
      statusCode: 409,
    });
  });
});

describe('AIRunService stopRun', () => {
  it('aborts the executor and flushes the active draft before publishing the stopped snapshot', async () => {
    const stopped = {
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      status: 'stopped',
      assistantDraftContent: 'Persisted fallback',
    };
    const harness = createTransitionDb(
      [stopped],
      [[{ id: 'conversation-1' }], [{ ...stopped, activeMessageId: 'message-1', status: 'running' }]]
    );
    const service = new AIRunService(harness.db as never);
    const executor = {
      abortRun: vi.fn(),
      flushAssistantDraftToMessage: vi.fn().mockResolvedValue('assistant-1'),
    };
    (service as unknown as { executor: typeof executor }).executor = executor;

    await expect(
      service.stopRun({
        conversationId: 'conversation-1',
        runId: 'run-1',
        userId: 'user-1',
      })
    ).resolves.toEqual({ run: stopped, duplicate: false });

    expect(executor.abortRun).toHaveBeenCalledWith('run-1');
    expect(executor.flushAssistantDraftToMessage).toHaveBeenCalledWith(
      'user-1',
      'conversation-1',
      'run-1',
      'Persisted fallback'
    );
    expect(executor.abortRun.mock.invocationCallOrder[0]).toBeLessThan(
      executor.flushAssistantDraftToMessage.mock.invocationCallOrder[0]
    );
  });

  it('stops a context compaction run through the ordinary stop path', async () => {
    const current = {
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      status: 'running',
      activeMessageId: null,
      assistantDraftContent: null,
    };
    const stopped = { ...current, status: 'stopped' };
    const harness = createTransitionDb([stopped], [[{ id: 'conversation-1' }], [current]]);
    const service = new AIRunService(harness.db as never);
    const executor = {
      abortRun: vi.fn(),
      flushAssistantDraftToMessage: vi.fn().mockResolvedValue(null),
    };
    (service as unknown as { executor: typeof executor }).executor = executor;

    await expect(
      service.stopRun({
        conversationId: 'conversation-1',
        runId: 'run-1',
        userId: 'user-1',
      })
    ).resolves.toEqual({ run: stopped, duplicate: false });
    expect(executor.abortRun).toHaveBeenCalledWith('run-1');
  });

  it('stops the current active run before rollback without trusting a client run id', async () => {
    const activeRun = {
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      status: 'running',
      activeMessageId: 'message-1',
      assistantDraftContent: 'Draft answer',
    };
    const stopped = { ...activeRun, status: 'stopped' };
    const harness = createStopActiveRunDb(
      [stopped],
      [[{ id: 'conversation-1' }], [activeRun], [{ id: 'conversation-1' }], [activeRun]]
    );
    const service = new AIRunService(harness.db as never);
    const executor = {
      abortRun: vi.fn(),
      flushAssistantDraftToMessage: vi.fn().mockResolvedValue('assistant-1'),
    };
    (service as unknown as { executor: typeof executor }).executor = executor;

    await expect(
      service.stopActiveRunForRollback({
        conversationId: 'conversation-1',
        userId: 'user-1',
      })
    ).resolves.toEqual({ run: stopped, duplicate: false });

    expect(executor.abortRun).toHaveBeenCalledWith('run-1');
  });

  it('allows rollback cancellation while the current active run is context compaction', async () => {
    const activeRun = {
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      status: 'running',
      activeMessageId: null,
      assistantDraftContent: null,
    };
    const stopped = { ...activeRun, status: 'stopped' };
    const harness = createStopActiveRunDb(
      [stopped],
      [[{ id: 'conversation-1' }], [activeRun], [{ id: 'conversation-1' }], [activeRun]]
    );
    const service = new AIRunService(harness.db as never);
    const executor = {
      abortRun: vi.fn(),
      flushAssistantDraftToMessage: vi.fn().mockResolvedValue(null),
    };
    (service as unknown as { executor: typeof executor }).executor = executor;

    await expect(
      service.stopActiveRunForRollback({
        conversationId: 'conversation-1',
        userId: 'user-1',
      })
    ).resolves.toEqual({ run: stopped, duplicate: false });
    expect(executor.abortRun).toHaveBeenCalledWith('run-1');
  });
});

describe('AIRunService runtime snapshots', () => {
  it('does not load runtime tool arguments for a conversation the user does not own', async () => {
    const limit = vi.fn(async () => []);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const service = new AIRunService({ select: vi.fn(() => ({ from })) } as never);
    const getRuntimeSnapshot = vi.fn();
    (service as unknown as { getRuntimeSnapshot: typeof getRuntimeSnapshot }).getRuntimeSnapshot = getRuntimeSnapshot;

    await expect(service.getConversationSnapshot('user-2', 'conversation-1')).resolves.toBeNull();
    expect(getRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('derives ended status from hidden conversation status messages', async () => {
    const now = new Date('2026-06-26T10:00:00.000Z');
    let whereCall = 0;
    const limit = vi.fn(async () => [
      {
        id: 'conversation-1',
        userId: 'user-1',
        title: 'Ended chat',
        createdAt: now,
        updatedAt: now,
        folderId: null,
        lastContext: null,
        discoveredToolsets: [],
        checkpoint: null,
      },
    ]);
    const orderBy = vi.fn(async () => [
      {
        id: 'status-1',
        sequence: 0,
        uiMessage: {
          role: 'assistant',
          content: '',
          conversationStatus: 'ended',
          blockReason: 'I can only help with Gateway infrastructure.',
        },
        createdAt: now,
      },
    ]);
    const where = vi.fn(() => {
      whereCall += 1;
      return whereCall === 1 ? { limit } : { orderBy };
    });
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const service = new AIRunService({ select } as never);
    (service as unknown as { getRuntimeSnapshot: (conversationId: string) => Promise<unknown> }).getRuntimeSnapshot = vi
      .fn()
      .mockResolvedValue({
        activeRun: null,
        assistantDraftContent: null,
        assistantDraftVersion: null,
        pendingApprovals: [],
        pendingQuestion: null,
        pendingQuestions: [],
        toolCalls: [],
      });

    const snapshot = await service.getConversationSnapshot('user-1', 'conversation-1');

    expect(snapshot?.conversation.status).toBe('ended');
    expect(snapshot?.conversation.blockReason).toBe('I can only help with Gateway infrastructure.');
    expect(snapshot?.conversation.messageCount).toBe(0);
  });

  it('returns only client-safe checkpoint metadata in conversation snapshots', async () => {
    const now = new Date('2026-06-26T10:00:00.000Z');
    let whereCall = 0;
    const limit = vi.fn(async () => [
      {
        id: 'conversation-1',
        title: 'Runtime chat',
        createdAt: now,
        updatedAt: now,
        folderId: null,
        lastContext: null,
        discoveredToolsets: [],
        checkpoint: {
          type: 'tool_approval_required',
          requestId: 'request-1',
          pendingMessages: [{ role: 'system', content: 'server-only system prompt' }],
          allQuestions: [],
          queuedApprovals: [{ id: 'call-2', name: 'restart_docker_container', arguments: { containerId: 'abc' } }],
        },
      },
    ]);
    const orderBy = vi.fn(async () => [
      {
        id: 'message-1',
        sequence: 0,
        uiMessage: { role: 'user', content: 'hello' },
        createdAt: now,
      },
    ]);
    const where = vi.fn(() => {
      whereCall += 1;
      return whereCall === 1 ? { limit } : { orderBy };
    });
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const service = new AIRunService({ select } as never);
    (service as unknown as { getRuntimeSnapshot: (conversationId: string) => Promise<unknown> }).getRuntimeSnapshot = vi
      .fn()
      .mockResolvedValue({
        activeRun: null,
        assistantDraftContent: null,
        assistantDraftVersion: null,
        pendingApprovals: [],
        pendingQuestion: null,
        pendingQuestions: [],
        toolCalls: [
          {
            id: 'tool-row-1',
            toolCallId: 'call-1',
            toolName: 'create_docker_container',
            toolArgs: { env: { API_KEY: 'owner-visible-value' } },
            status: 'completed',
            resourceReferences: [
              {
                refId: 'gwr_0123456789abcdef01234567',
                type: 'docker_container',
                resourceId: 'container-1',
                label: 'runtime-container',
                relation: 'created',
                nodeId: 'node-1',
                nodeSlug: 'docker-src',
              },
            ],
          },
        ],
      });

    const snapshot = await service.getConversationSnapshot('user-1', 'conversation-1');

    expect(snapshot?.conversation.checkpoint).toEqual({
      type: 'tool_approval_required',
      requestId: 'request-1',
      allQuestions: [],
      queuedApprovals: [{ id: 'call-2', name: 'restart_docker_container', arguments: { containerId: 'abc' } }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('server-only system prompt');
    expect(snapshot?.runtime.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'create_docker_container',
        toolArgs: { env: { API_KEY: 'owner-visible-value' } },
      }),
    ]);
    expect(snapshot?.resourceReferences).toEqual([
      expect.objectContaining({
        refId: 'gwr_0123456789abcdef01234567',
        type: 'docker_container',
        label: 'runtime-container',
      }),
    ]);
  });

  it('offers continuation only when the most recent run stopped before a final response', async () => {
    const limit = vi.fn().mockResolvedValue([{ status: 'stopped' }]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit })) })),
        })),
      })),
    };
    const service = new AIRunService(db as never);
    (service as unknown as { getActiveRun: (conversationId: string) => Promise<unknown> }).getActiveRun = vi
      .fn()
      .mockResolvedValue(null);
    (
      service as unknown as { listConversationToolCalls: (conversationId: string) => Promise<unknown[]> }
    ).listConversationToolCalls = vi.fn().mockResolvedValue([]);

    await expect(
      (service as unknown as { getRuntimeSnapshot: (conversationId: string) => Promise<unknown> }).getRuntimeSnapshot(
        'conversation-1'
      )
    ).resolves.toMatchObject({
      activeRun: null,
      canContinue: true,
    });
  });

  it('uses the in-memory live draft and version when an active run is streaming', async () => {
    const run = {
      id: 'run-1',
      conversationId: 'conversation-1',
      assistantDraftContent: 'Persisted draft',
    };
    const service = new AIRunService(createRuntimeSnapshotDb() as never);
    (service as unknown as { getActiveRun: (conversationId: string) => Promise<unknown> }).getActiveRun = vi
      .fn()
      .mockResolvedValue(run);
    (
      service as unknown as { listConversationToolCalls: (conversationId: string) => Promise<unknown[]> }
    ).listConversationToolCalls = vi.fn().mockResolvedValue([]);
    (service as unknown as { executor: { getAssistantDraft: (runId: string) => unknown } }).executor = {
      getAssistantDraft: vi.fn(() => ({
        runId: 'run-1',
        conversationId: 'conversation-1',
        content: 'Live draft',
        version: 7,
      })),
    };

    await expect(
      (service as unknown as { getRuntimeSnapshot: (conversationId: string) => Promise<unknown> }).getRuntimeSnapshot(
        'conversation-1'
      )
    ).resolves.toMatchObject({
      activeRun: run,
      assistantDraftContent: 'Live draft',
      assistantDraftVersion: 7,
    });
  });

  it('falls back to persisted assistant draft content when no live draft exists', async () => {
    const run = {
      id: 'run-1',
      conversationId: 'conversation-1',
      assistantDraftContent: 'Persisted draft',
    };
    const service = new AIRunService(createRuntimeSnapshotDb() as never);
    (service as unknown as { getActiveRun: (conversationId: string) => Promise<unknown> }).getActiveRun = vi
      .fn()
      .mockResolvedValue(run);
    (
      service as unknown as { listConversationToolCalls: (conversationId: string) => Promise<unknown[]> }
    ).listConversationToolCalls = vi.fn().mockResolvedValue([]);
    (service as unknown as { executor: { getAssistantDraft: (runId: string) => unknown } }).executor = {
      getAssistantDraft: vi.fn(() => null),
    };

    await expect(
      (service as unknown as { getRuntimeSnapshot: (conversationId: string) => Promise<unknown> }).getRuntimeSnapshot(
        'conversation-1'
      )
    ).resolves.toMatchObject({
      activeRun: run,
      assistantDraftContent: 'Persisted draft',
      assistantDraftVersion: 0,
    });
  });

  it('resumes a durably resolved credential challenge for a waiting run', async () => {
    const run = {
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      status: 'waiting_for_credential',
    };
    const challenge = {
      id: 'challenge-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      status: 'authorized',
    };
    let selectCall = 0;
    const select = vi.fn(() => {
      selectCall += 1;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() =>
            selectCall === 1
              ? { limit: vi.fn().mockResolvedValue([run]) }
              : { orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([challenge]) })) }
          ),
        })),
      };
    });
    const service = new AIRunService({ select } as never);
    const startCredentialContinuation = vi.fn();
    (service as unknown as { executor: { startCredentialContinuation: typeof startCredentialContinuation } }).executor =
      {
        startCredentialContinuation,
      };
    const user = {
      id: 'user-1',
      oidcSubject: 'oidc-user',
      email: 'user@example.com',
      name: 'User',
      avatarUrl: null,
      groupId: 'group-1',
      groupName: 'users',
      scopes: ['feat:ai:use'],
      isBlocked: false,
    };

    await expect(
      service.resumeResolvedCredentialContinuation(user, {
        conversationId: 'conversation-1',
        runId: 'run-1',
      })
    ).resolves.toBe(true);
    expect(startCredentialContinuation).toHaveBeenCalledWith(user, {
      conversationId: 'conversation-1',
      runId: 'run-1',
      challenge,
      authorized: true,
    });
  });

  it('authorizes every pending challenge for the same user and connector', async () => {
    const current = {
      id: 'challenge-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      connectorId: 'connector-1',
      status: 'authorized',
    };
    const additional = {
      id: 'challenge-2',
      runId: 'run-2',
      conversationId: 'conversation-2',
      userId: 'user-1',
      connectorId: 'connector-1',
      status: 'authorized',
    };
    const harness = createTransitionDb([current]);
    harness.returning.mockResolvedValueOnce([current]).mockResolvedValueOnce([additional]);
    const service = new AIRunService(harness.db as never);

    await expect(
      service.resolveCredentialChallenge({
        conversationId: 'conversation-1',
        runId: 'run-1',
        challengeId: 'challenge-1',
        userId: 'user-1',
        clientCommandId: 'command-1',
        decision: 'authorized',
      })
    ).resolves.toEqual({ challenge: current, additionalChallenges: [additional], duplicate: false });
    expect(harness.update).toHaveBeenCalledTimes(2);
  });
});

describe('AIRunService restart reconciliation', () => {
  it('marks an interrupted in-flight tool effect as unknown instead of replaying it', async () => {
    const selectWhere = vi.fn().mockResolvedValue([{ id: 'call-row-1', roundId: 'round-1' }]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) }));
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    const service = new AIRunService({ select, update } as never);

    const effectUnknown = await (
      service as unknown as {
        reconcileInterruptedRunningRun(run: { id: string; conversationId: string; userId: string }): Promise<boolean>;
      }
    ).reconcileInterruptedRunningRun({
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
    });

    expect(effectUnknown).toBe(true);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'effect_unknown',
        error: expect.stringContaining('AI_TOOL_EFFECT_UNKNOWN'),
      })
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('AI_TOOL_EFFECT_UNKNOWN'),
      })
    );
    expect(updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
  });

  it('requeues interrupted provider streaming when no tool effect was in flight', async () => {
    const selectWhere = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) }));
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    const service = new AIRunService({ select, update } as never);

    const effectUnknown = await (
      service as unknown as {
        reconcileInterruptedRunningRun(run: { id: string; conversationId: string; userId: string }): Promise<boolean>;
      }
    ).reconcileInterruptedRunningRun({
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
    });

    expect(effectUnknown).toBe(false);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', leaseOwner: null, leaseExpiresAt: null })
    );
  });

  it('pauses an executing plan when its run fails', async () => {
    const planService = {
      getActivePlanSnapshot: vi.fn().mockResolvedValue({
        id: 'plan-1',
        status: 'executing',
      }),
      pause: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AIRunService({} as never, undefined, undefined, planService as never);

    const paused = await (
      service as unknown as {
        pausePlanAfterFailedRun(
          run: {
            conversationId: string;
            userId: string;
            planId: string | null;
            purpose: 'plan_execution';
          },
          reason: string
        ): Promise<boolean>;
      }
    ).pausePlanAfterFailedRun(
      {
        conversationId: 'conversation-1',
        userId: 'user-1',
        planId: 'plan-1',
        purpose: 'plan_execution',
      },
      'AI run failed: provider failed'
    );

    expect(paused).toBe(true);
    expect(planService.pause).toHaveBeenCalledWith('user-1', 'conversation-1', 'AI run failed: provider failed');
  });

  it('returns a failed plan validation to drafting', async () => {
    const planService = {
      recoverFailedValidation: vi.fn().mockResolvedValue(true),
    };
    const service = new AIRunService({} as never, undefined, undefined, planService as never);

    await (
      service as unknown as {
        handleFailedRun(user: User, run: AIRun, error: string): Promise<void>;
      }
    ).handleFailedRun(
      { id: 'user-1' } as User,
      {
        id: 'run-1',
        conversationId: 'conversation-1',
        userId: 'user-1',
        planId: 'plan-1',
        purpose: 'plan_validation',
      } as AIRun,
      'provider failed'
    );

    expect(planService.recoverFailedValidation).toHaveBeenCalledWith(
      'user-1',
      'conversation-1',
      'plan-1',
      'Plan validation failed: provider failed'
    );
  });
});
