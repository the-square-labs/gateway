import 'reflect-metadata';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { resetIdempotencyStateForTests } from '@/middleware/idempotency.js';
import {
  FailingIdempotencyRedis,
  MemoryIdempotencyRedis,
  registerIdempotencyRedis,
  registerIdempotencyRuntime,
} from '@/middleware/idempotency.test-helpers.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { AI_TOOLS } from '@/modules/ai/ai.tools.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv, User } from '@/types.js';
import { mcpRoutes } from './mcp.routes.js';
import { MCP_IDEMPOTENT_CREATE_TOOLS } from './mcp-idempotency.js';
import { McpSettingsService } from './mcp-settings.service.js';
import { resetMcpDiscoveryStateForTests } from './mcp-tools.js';

type JsonRecord = Record<string, any>;

const SCOPES = [
  'mcp:use',
  'proxy:folders:manage',
  'proxy:view',
  'docker:compose:view',
  'docker:compose:manage',
  'nodes:create',
];

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'agent@example.com',
  name: 'Agent',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: SCOPES,
  isBlocked: false,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  app.route('/api/mcp', mcpRoutes);
  return app;
}

function registerOAuth(tokens: Record<string, string>, owner: User = USER) {
  container.registerInstance(OAuthService, {
    getMcpResourceUrl: vi.fn().mockReturnValue('https://gateway.example.com/api/mcp'),
    getApiResourceUrl: vi.fn().mockReturnValue('https://gateway.example.com/api'),
    getProtectedResourceMetadataUrl: vi
      .fn()
      .mockReturnValue('https://gateway.example.com/.well-known/oauth-protected-resource/api/mcp'),
    validateAccessToken: vi.fn(async (raw: string) =>
      tokens[raw]
        ? { user: owner, scopes: SCOPES, tokenId: tokens[raw], tokenPrefix: raw.slice(0, 10), clientId: 'goc_client' }
        : null
    ),
  } as unknown as OAuthService);
}

async function mcpRequest(method: string, params: Record<string, unknown> = {}, token = 'gwo_agent_one') {
  const response = await createApp().request('/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const messages: JsonRecord[] = contentType.includes('application/json')
    ? [await response.json()]
    : (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)));
  const body = messages.find((message) => message.id === 1) ?? messages.at(-1);
  if (!body) throw new Error('MCP response did not contain a JSON-RPC result');
  return body.result as JsonRecord;
}

function callTool(name: string, args: Record<string, unknown>, token?: string) {
  return mcpRequest('tools/call', { name, arguments: args }, token);
}

let redis: MemoryIdempotencyRedis;
let executeTool: ReturnType<typeof vi.fn>;
let auditLog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetIdempotencyStateForTests();
  redis = new MemoryIdempotencyRedis();
  registerIdempotencyRedis(redis);
  container.registerInstance(McpSettingsService, {
    getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: true }),
  } as unknown as McpSettingsService);
  registerOAuth({ gwo_agent_one: 'oauth-token-1', gwo_agent_two: 'oauth-token-2' });
  ({ auditLog } = registerIdempotencyRuntime());
  let created = 0;
  executeTool = vi.fn(async (_user: User, _toolName: string, args: Record<string, unknown>) => {
    created += 1;
    return { result: { id: `folder-${created}`, name: args.name }, invalidateStores: [] };
  });
  container.registerInstance(AIService, { executeTool } as unknown as AIService);
});

afterEach(() => {
  resetMcpDiscoveryStateForTests();
  container.reset();
});

describe('MCP idempotencyKey', () => {
  it('covers only existing create tools', () => {
    const names = new Set(AI_TOOLS.map((tool) => tool.name));
    expect(Object.keys(MCP_IDEMPOTENT_CREATE_TOOLS).filter((name) => !names.has(name))).toEqual([]);
  });

  it('advertises idempotencyKey on create tools only', async () => {
    const { tools } = await mcpRequest('tools/list');
    const byName = new Map((tools as JsonRecord[]).map((tool) => [tool.name, tool]));

    const create = byName.get('create_route_folder');
    expect(create?.inputSchema.properties.idempotencyKey).toMatchObject({ type: 'string', maxLength: 255 });
    expect(create?.description).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(byName.get('manage_docker_compose')?.description).toContain('with operation "create"');
    expect(byName.get('list_routes')?.inputSchema.properties ?? {}).not.toHaveProperty('idempotencyKey');
    // create_node returns a one-time enrollment token, so it never takes an idempotency key.
    expect(byName.get('create_node')).toBeDefined();
    expect(byName.get('create_node')?.inputSchema.properties).not.toHaveProperty('idempotencyKey');
  });

  it('keeps every secret-returning tool and operation off the idempotent list', () => {
    const secretTools = [
      'create_node',
      'create_access_list',
      'create_webhook',
      'issue_certificate',
      'manage_api_token',
      'manage_inference_token',
      'manage_oauth_authorization',
    ];
    for (const name of secretTools) expect(MCP_IDEMPOTENT_CREATE_TOOLS, name).not.toHaveProperty(name);
    const secretOperations = [
      'token_create',
      'create_access_key',
      'import_access_keys',
      'create_binding',
      'reveal_credentials',
      'rotate_credentials',
      'regenerate_enrollment_token',
    ];
    for (const [name, rule] of Object.entries(MCP_IDEMPOTENT_CREATE_TOOLS)) {
      for (const operation of rule.operations ?? []) {
        expect(secretOperations, `${name}.${operation}`).not.toContain(operation);
      }
    }
  });

  it('withholds a secret-looking result: the retry learns only that the call completed', async () => {
    executeTool.mockResolvedValueOnce({
      result: { id: 'folder-secret', enrollmentToken: 'enroll-secret-value' },
      invalidateStores: [],
    });

    const first = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-secret' });
    const retry = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-secret' });

    expect(first.isError).not.toBe(true);
    expect(retry.isError).toBe(true);
    expect(retry.content[0].text).toContain('IDEMPOTENCY_RESULT_WITHHELD');
    expect(retry.content[0].text).not.toContain('enroll-secret-value');
    expect(redis.dump()).not.toContain('enroll-secret-value');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.create_route_folder',
        details: expect.objectContaining({ idempotencyReplayed: true, withheld: true }),
      })
    );
  });

  it('never replays a result after the owner loses a scope', async () => {
    await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-owner' });
    registerOAuth(
      { gwo_agent_one: 'oauth-token-1' },
      { ...USER, scopes: SCOPES.filter((scope) => scope !== 'nodes:create') }
    );
    const retry = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-owner' });

    expect(retry._meta).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('replays the original result for a retry instead of creating twice', async () => {
    const first = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-1' });
    const retry = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-1' });

    expect(first.isError).not.toBe(true);
    expect(JSON.parse(first.content[0].text)).toEqual({ id: 'folder-1', name: 'office' });
    expect(first._meta?.idempotencyReplayed).toBeUndefined();
    expect(retry.content).toEqual(first.content);
    expect(retry._meta).toEqual({ idempotencyReplayed: true });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(redis.dump()).not.toContain('office');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        action: 'mcp.create_route_folder',
        details: expect.objectContaining({ idempotencyReplayed: true, withheld: false, tokenId: 'oauth-token-1' }),
      })
    );
    // The key is MCP plumbing: the tool executor never sees it.
    expect(executeTool.mock.calls[0]?.[2]).toEqual({ name: 'office' });
  });

  it('rejects different arguments under the same key and isolates tokens', async () => {
    await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-2' });
    const reused = await callTool('create_route_folder', { name: 'lab', idempotencyKey: 'agent-folder-2' });
    const otherToken = await callTool(
      'create_route_folder',
      { name: 'office', idempotencyKey: 'agent-folder-2' },
      'gwo_agent_two'
    );

    expect(reused.isError).toBe(true);
    expect(reused.content[0].text).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(otherToken.isError).not.toBe(true);
    expect(otherToken._meta).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('reports a call still running as IDEMPOTENCY_KEY_IN_PROGRESS', async () => {
    let finish!: () => void;
    executeTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ result: { id: 'folder-slow' }, invalidateStores: [] });
        })
    );

    const first = callTool('create_route_folder', { name: 'slow', idempotencyKey: 'agent-folder-3' });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledTimes(1));
    const concurrent = await callTool('create_route_folder', { name: 'slow', idempotencyKey: 'agent-folder-3' });
    finish();
    await first;
    const retry = await callTool('create_route_folder', { name: 'slow', idempotencyKey: 'agent-folder-3' });

    expect(concurrent.isError).toBe(true);
    expect(concurrent.content[0].text).toContain('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(JSON.parse(retry.content[0].text)).toEqual({ id: 'folder-slow' });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('releases the key when the tool fails so a retry runs again', async () => {
    executeTool.mockResolvedValueOnce({ error: 'node unreachable', invalidateStores: [] });

    const failed = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-4' });
    const retry = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-4' });

    expect(failed.isError).toBe(true);
    expect(retry.isError).not.toBe(true);
    expect(retry._meta).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('runs normally when Redis is down', async () => {
    registerIdempotencyRedis(new FailingIdempotencyRedis());

    await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-5' });
    const second = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'agent-folder-5' });

    expect(second.isError).not.toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed keys before executing', async () => {
    const result = await callTool('create_route_folder', { name: 'office', idempotencyKey: 'x'.repeat(256) });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('IDEMPOTENCY_KEY_INVALID');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('keeps Compose lifecycle idempotency keys in the tool arguments', async () => {
    const args = {
      operation: 'operation_start',
      nodeId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333',
      action: 'restart',
      idempotencyKey: 'compose-restart-0001',
    };

    await callTool('manage_docker_compose', args);
    await callTool('manage_docker_compose', args);

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[0]?.[2]).toMatchObject({ idempotencyKey: 'compose-restart-0001' });
    expect(redis.entries.size).toBe(0);
  });
});
