import { describe, expect, it } from 'vitest';
import { normalizeCheckpoint, toChatMessage, toCheckpoint, toClientCheckpoint } from './ai-run-runtime.helpers.js';

describe('AI run runtime checkpoint helpers', () => {
  it('does not send persisted UI-only errors back to the model', () => {
    expect(
      toChatMessage({
        role: 'assistant',
        content: '**Error:** Provider is rate limited.',
        localOnly: true,
      })
    ).toBeNull();
  });

  it('keeps server pending messages for resume but omits them from client checkpoints', () => {
    const raw = toCheckpoint({
      type: 'tool_approval_required',
      requestId: 'request-1',
      id: 'call-1',
      name: 'pull_docker_image',
      arguments: { imageRef: 'redis:latest' },
      _pendingMessages: [
        { role: 'system', content: 'server-only system prompt' },
        { role: 'user', content: 'pull redis' },
      ],
      _queuedApprovals: [{ id: 'call-2', name: 'restart_docker_container', arguments: { containerId: 'abc' } }],
    } as never);

    expect(normalizeCheckpoint(raw).pendingMessages).toEqual([
      { role: 'system', content: 'server-only system prompt' },
      { role: 'user', content: 'pull redis' },
    ]);
    expect(normalizeCheckpoint(raw).pendingApproval).toBeNull();
    expect(toClientCheckpoint(raw)).toEqual({
      type: 'tool_approval_required',
      requestId: 'request-1',
      allQuestions: [],
      queuedApprovals: [{ id: 'call-2', name: 'restart_docker_container', arguments: { containerId: 'abc' } }],
    });
  });

  it('uses raw queued approval arguments on the server and redacted arguments for client checkpoints', () => {
    const raw = toCheckpoint({
      type: 'tool_approval_required',
      requestId: 'request-1',
      id: 'call-1',
      name: 'gitlab_set_project_variable',
      arguments: { key: 'TOKEN', value: '[REDACTED]' },
      _rawArguments: { key: 'TOKEN', value: 'secret-value' },
      _pendingMessages: [],
      _queuedApprovals: [
        {
          id: 'call-2',
          name: 'gitlab_set_project_variable',
          arguments: { key: 'TOKEN', value: '[REDACTED]' },
          rawArguments: { key: 'TOKEN', value: 'secret-value' },
        },
      ],
    } as never);

    const checkpoint = normalizeCheckpoint(raw);
    expect(checkpoint.pendingApproval).toEqual({
      id: 'call-1',
      name: 'gitlab_set_project_variable',
      arguments: { key: 'TOKEN', value: 'secret-value' },
    });
    expect(checkpoint.queuedApprovals).toEqual([
      { id: 'call-2', name: 'gitlab_set_project_variable', arguments: { key: 'TOKEN', value: 'secret-value' } },
    ]);
    expect(toClientCheckpoint(raw)?.queuedApprovals).toEqual([
      { id: 'call-2', name: 'gitlab_set_project_variable', arguments: { key: 'TOKEN', value: '[REDACTED]' } },
    ]);
  });

  it('keeps GitLab tool arguments server-side while exposing no credential challenge payload in checkpoints', () => {
    const raw = toCheckpoint({
      type: 'credential_authorization_required',
      requestId: 'request-1',
      id: 'call-1',
      name: 'gitlab_read_file',
      provider: 'gitlab',
      connectorId: 'connector-1',
      arguments: { connectorId: 'connector-1', project: 'group/app', path: 'README.md' },
      _rawArguments: { connectorId: 'connector-1', project: 'group/app', path: 'README.md' },
      _pendingMessages: [{ role: 'user', content: 'read the file' }],
    } as never);

    expect(normalizeCheckpoint(raw).pendingCredential).toEqual({
      id: 'call-1',
      name: 'gitlab_read_file',
      connectorId: 'connector-1',
      arguments: { connectorId: 'connector-1', project: 'group/app', path: 'README.md' },
    });
    expect(toClientCheckpoint(raw)).toEqual({
      type: 'credential_authorization_required',
      requestId: 'request-1',
      allQuestions: [],
      queuedApprovals: [],
    });
    expect(JSON.stringify(raw)).not.toContain('glpat-');
  });
});
