import { describe, expect, it } from 'vitest';
import {
  countVisibleMessages,
  deriveConversationStatus,
  sanitizeConversationMessagesForStorage,
  sortConversationSummariesByLastUserMessage,
} from './ai-conversation.service.js';

describe('AIConversationService visible message count', () => {
  it('does not count model-change timeline events as chat messages', () => {
    expect(
      countVisibleMessages([
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: '',
          localOnly: true,
          modelChange: { fromModel: 'model-a', toModel: 'model-b' },
        },
        { role: 'assistant', content: 'Hi' },
      ])
    ).toBe(2);
  });
});

function toolCall(index: number) {
  return {
    id: `tool-${index}`,
    name: 'unknown_default_tool',
    status: 'completed',
    result: `raw output ${index}`,
  };
}

describe('AIConversationService storage sanitization', () => {
  it('keeps only the latest 10 non-question tool outputs in saved messages', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          ...Array.from({ length: 12 }, (_, index) => toolCall(index + 1)),
          {
            id: 'question-1',
            name: 'ask_question',
            status: 'completed',
            result: { answer: 'yes' },
          },
        ],
      },
    ];

    const [sanitized] = sanitizeConversationMessagesForStorage(messages) as Array<{
      toolCalls: Array<{ id: string; result: unknown }>;
    }>;

    expect(sanitized.toolCalls[0].result).toMatchObject({
      summary: 'Tool output omitted from saved conversation after the latest 10 recent-full tool calls.',
      fullOutputOmitted: true,
      historyRetention: 'recent_full',
      toolName: 'unknown_default_tool',
    });
    expect(sanitized.toolCalls[1].result).toMatchObject({
      summary: 'Tool output omitted from saved conversation after the latest 10 recent-full tool calls.',
      fullOutputOmitted: true,
      historyRetention: 'recent_full',
      toolName: 'unknown_default_tool',
    });
    expect(sanitized.toolCalls[2].result).toBe('raw output 3');
    expect(sanitized.toolCalls[11].result).toBe('raw output 12');
    expect(sanitized.toolCalls[12].result).toEqual({ answer: 'yes' });
  });

  it('keeps persistent context tool outputs beyond the latest 10 default tool outputs', () => {
    const [sanitized] = sanitizeConversationMessagesForStorage([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'docs-call-1',
            name: 'internal_documentation',
            status: 'completed',
            result: { topic: 'gitlab', body: 'connector setup docs' },
          },
          ...Array.from({ length: 12 }, (_, index) => toolCall(index + 1)),
        ],
      },
    ]) as Array<{ toolCalls: Array<{ result: unknown }> }>;

    expect(sanitized.toolCalls[0].result).toEqual({ topic: 'gitlab', body: 'connector setup docs' });
  });

  it('stores summary-only tool outputs as metadata even when they are recent', () => {
    const [sanitized] = sanitizeConversationMessagesForStorage([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'logs-call-1',
            name: 'get_docker_container_logs',
            status: 'completed',
            result: 'large log output',
          },
        ],
      },
    ]) as Array<{ toolCalls: Array<{ result: unknown }> }>;

    expect(sanitized.toolCalls[0].result).toMatchObject({
      summary: 'Tool output omitted from saved conversation by tool history retention policy.',
      fullOutputOmitted: true,
      historyRetention: 'summary_only',
      toolName: 'get_docker_container_logs',
      resultType: 'string',
    });
  });

  it('does not let summary-only tool calls consume recent-full retention slots', () => {
    const [sanitized] = sanitizeConversationMessagesForStorage([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          ...Array.from({ length: 10 }, (_, index) => toolCall(index + 1)),
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `logs-call-${index + 1}`,
            name: 'get_docker_container_logs',
            status: 'completed',
            result: `large log output ${index + 1}`,
          })),
        ],
      },
    ]) as Array<{ toolCalls: Array<{ result: unknown }> }>;

    expect(sanitized.toolCalls[0].result).toBe('raw output 1');
    expect(sanitized.toolCalls[9].result).toBe('raw output 10');
    expect(sanitized.toolCalls[10].result).toMatchObject({
      fullOutputOmitted: true,
      historyRetention: 'summary_only',
      toolName: 'get_docker_container_logs',
    });
  });

  it('does not store one-time API token result payloads even when the tool call is recent', () => {
    const [sanitized] = sanitizeConversationMessagesForStorage([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'token-call-1',
            name: 'manage_api_token',
            status: 'completed',
            result: { id: 'token-1', name: 'Deploy', token: 'gw_secret' },
          },
        ],
      },
    ]) as Array<{ toolCalls: Array<{ result: unknown }> }>;

    expect(sanitized.toolCalls[0].result).toMatchObject({
      summary: 'Tool output omitted from saved conversation by tool history retention policy.',
      fullOutputOmitted: true,
      historyRetention: 'never_full',
      toolName: 'manage_api_token',
    });
    expect(JSON.stringify(sanitized.toolCalls[0].result)).not.toContain('gw_secret');
  });

  it('summarizes oversized persistent context tool outputs', () => {
    const [sanitized] = sanitizeConversationMessagesForStorage([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'docs-call-1',
            name: 'internal_documentation',
            status: 'completed',
            result: { body: 'x'.repeat(40000) },
          },
        ],
      },
    ]) as Array<{ toolCalls: Array<{ result: unknown }> }>;

    expect(sanitized.toolCalls[0].result).toMatchObject({
      summary: 'Tool output exceeded the 32000 byte persistent context retention limit.',
      fullOutputOmitted: true,
      historyRetention: 'persistent_context',
      toolName: 'internal_documentation',
      retainedBytesLimit: 32000,
    });
  });
});

describe('AIConversationService conversation ordering', () => {
  it('sorts conversations by the latest user message time', () => {
    const olderUserMessageWithNewerAssistantUpdate = {
      id: 'older-user-message',
      createdAt: new Date('2026-06-26T09:00:00.000Z'),
      updatedAt: new Date('2026-06-26T12:00:00.000Z'),
      lastUserMessageAt: new Date('2026-06-26T09:30:00.000Z'),
    };
    const newerUserMessageWithOlderAssistantUpdate = {
      id: 'newer-user-message',
      createdAt: new Date('2026-06-26T08:00:00.000Z'),
      updatedAt: new Date('2026-06-26T10:00:00.000Z'),
      lastUserMessageAt: new Date('2026-06-26T10:30:00.000Z'),
    };

    expect(
      sortConversationSummariesByLastUserMessage([
        olderUserMessageWithNewerAssistantUpdate,
        newerUserMessageWithOlderAssistantUpdate,
      ]).map((conversation) => conversation.id)
    ).toEqual(['newer-user-message', 'older-user-message']);
  });
});

describe('AIConversationService conversation status', () => {
  it('lets a compact marker recover a conversation from context-blocked state', () => {
    expect(
      deriveConversationStatus([
        {
          role: 'assistant',
          content: '',
          conversationStatus: 'context_blocked',
          blockReason: 'Context window exceeded',
        },
        {
          role: 'assistant',
          content: 'Compacted summary',
          compactMarker: true,
        },
      ])
    ).toEqual({ status: 'active', blockReason: null });
  });
});
