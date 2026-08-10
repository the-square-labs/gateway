import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { AIService } from './ai.service.js';
import type { AIConfig, ChatMessage, WSServerMessage } from './ai.types.js';

const mocks = vi.hoisted(() => ({ streamModelResponse: vi.fn() }));

vi.mock('./ai.provider-adapter.js', () => ({
  streamModelResponse: mocks.streamModelResponse,
}));

const CONFIG: AIConfig = {
  enabled: true,
  providerType: 'openai_compatible',
  supportsImages: false,
  providerUrl: '',
  endpointMode: 'responses',
  model: 'deterministic-assistant-e2e',
  gatewayInferenceModel: '',
  gatewayInferenceAllowUserModelSelection: false,
  maxCompletionTokens: 1024,
  maxTokensField: 'max_completion_tokens',
  reasoningEffort: 'none',
  customSystemPrompt: '',
  rateLimitMax: 10,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 4,
  maxContextTokens: 64_000,
  disabledTools: [],
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchBaseUrl: '',
  sandboxEnabled: false,
  sandboxDefaultTier: 'low',
};

const USER: User = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['feat:ai:use', 'docker:containers:create:node-1', 'docker:containers:environment:node-1'],
  isBlocked: false,
  aiApprovalMode: 'normal',
};

async function collect(events: AsyncGenerator<WSServerMessage>): Promise<WSServerMessage[]> {
  const collected: WSServerMessage[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function createService(dockerService: Record<string, unknown>) {
  return new AIService(
    {
      getConfig: vi.fn().mockResolvedValue(CONFIG),
      getDecryptedApiKey: vi.fn().mockResolvedValue('sk-e2e'),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dockerService as never
  );
}

describe('deterministic assistant Docker deployment flow', () => {
  afterEach(() => {
    mocks.streamModelResponse.mockReset();
    vi.restoreAllMocks();
  });

  it('validates, approves, creates, starts, resolves identity, and patches env through real tool routing', async () => {
    const responses = [
      {
        toolCalls: [
          {
            id: 'create-1',
            name: 'create_docker_container',
            arguments: JSON.stringify({
              nodeId: 'node-1',
              image: 'nginx:alpine',
              name: 'admin-stage',
              env: { APP_ENV: 'stage' },
              ports: [{ hostPort: 36406, containerPort: 3003, protocol: 'tcp' }],
            }),
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'env-1',
            name: 'manage_docker_container_config',
            arguments: JSON.stringify({
              operation: 'update_env',
              nodeId: 'node-1',
              containerId: 'container-1',
              containerName: 'admin-stage',
              env: { GAME_BACKEND_URL: 'http://192.0.2.61:36301' },
            }),
          },
        ],
      },
      { content: 'Тестовое окружение развёрнуто.', toolCalls: [] },
    ];
    mocks.streamModelResponse.mockImplementation(async function* () {
      const response = responses.shift();
      if (!response) throw new Error('unexpected deterministic provider round');
      if (response.content) yield { type: 'text_delta', content: response.content };
      yield { type: 'model_response', response: { content: response.content ?? '', toolCalls: response.toolCalls } };
    });

    const inspect = { Id: 'container-1', Name: '/admin-stage', State: { Status: 'running' } };
    const dockerService = {
      createContainer: vi.fn().mockResolvedValue({ id: 'container-1', name: 'admin-stage' }),
      startContainer: vi.fn().mockResolvedValue(undefined),
      inspectContainer: vi.fn().mockResolvedValue(inspect),
      updateContainerEnv: vi.fn().mockResolvedValue({ taskId: 'task-env-1', name: 'admin-stage' }),
      rollbackCreatedContainer: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dockerService);
    vi.spyOn(service, 'buildSystemPrompt').mockResolvedValue('System prompt');
    const messages: ChatMessage[] = [{ role: 'user', content: 'Разверни Docker admin stage и настрой backend URL' }];

    const createEvents = await collect(
      service.streamChat(USER, messages, undefined, new AbortController().signal, 'request-1')
    );
    const createApproval = createEvents.find((event) => event.type === 'tool_approval_required') as any;
    expect(createApproval).toMatchObject({ name: 'create_docker_container' });
    expect(dockerService.createContainer).not.toHaveBeenCalled();

    const envEvents = await collect(
      service.resumeAfterApproval(
        USER,
        createApproval.id,
        createApproval.name,
        createApproval._rawArguments,
        true,
        createApproval._pendingMessages,
        undefined,
        new AbortController().signal,
        'request-1'
      )
    );
    const envApproval = envEvents.find((event) => event.type === 'tool_approval_required') as any;
    expect(envApproval).toMatchObject({ name: 'manage_docker_container_config' });
    expect(dockerService.createContainer).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ env: { APP_ENV: 'stage' } }),
      'user-1',
      USER.scopes
    );
    expect(dockerService.startContainer).toHaveBeenCalledWith('node-1', 'container-1', 'user-1');

    const finalEvents = await collect(
      service.resumeAfterApproval(
        USER,
        envApproval.id,
        envApproval.name,
        envApproval._rawArguments,
        true,
        envApproval._pendingMessages,
        undefined,
        new AbortController().signal,
        'request-1'
      )
    );

    expect(dockerService.updateContainerEnv).toHaveBeenCalledWith(
      'node-1',
      'container-1',
      { GAME_BACKEND_URL: 'http://192.0.2.61:36301' },
      undefined,
      'user-1'
    );
    expect(finalEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_result', name: 'manage_docker_container_config' }),
        expect.objectContaining({ type: 'text_delta', content: 'Тестовое окружение развёрнуто.' }),
        expect.objectContaining({ type: 'done' }),
      ])
    );
    expect(dockerService.rollbackCreatedContainer).not.toHaveBeenCalled();
  });
});
