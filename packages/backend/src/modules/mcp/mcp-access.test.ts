import 'reflect-metadata';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { dockerContainerFolders, nodes, proxyHostFolders, proxyHosts } from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv, User } from '@/types.js';
import { mcpRoutes } from './mcp.routes.js';
import { MCP_ACCESS_RESOURCE_URI } from './mcp-access.js';
import { createService, USER } from './mcp-ai-audit.test-helpers.js';
import { MCP_SERVER_INSTRUCTIONS } from './mcp-server.factory.js';
import { McpSettingsService } from './mcp-settings.service.js';
import { registerMcpToolHandlers, resetMcpDiscoveryStateForTests } from './mcp-tools.js';

const FOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROUTE_FOLDER = 'bbbbbbbb-0000-4000-8000-000000000001';
const ROUTE_IN = 'eeeeeeee-0000-4000-8000-000000000001';
const ROUTE_OUT = 'eeeeeeee-0000-4000-8000-000000000002';
const NODE = '44444444-4444-4444-8444-444444444444';

function testDb() {
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [dockerContainerFolders, [{ id: FOLDER, name: 'MyProject', parentId: null, resourceType: 'container' }]],
    [proxyHostFolders, [{ id: ROUTE_FOLDER, name: 'MyProject routes', parentId: null }]],
    [
      proxyHosts,
      [
        { id: ROUTE_IN, folderId: ROUTE_FOLDER, domainNames: ['app.example.com'] },
        { id: ROUTE_OUT, folderId: null, domainNames: ['other.example.com'] },
      ],
    ],
    [nodes, [{ id: NODE, hostname: 'edge-01', displayName: null }]],
  ]);
  return {
    select: () => ({
      from: (table: unknown) => {
        const result = () => Promise.resolve([...(rows.get(table) ?? [])]);
        return Object.assign(result(), { where: () => result() });
      },
    }),
  };
}

const FOLDER_GRANTS = [
  `docker:containers:view:folder/${FOLDER}`,
  `docker:containers:create:folder/${FOLDER}`,
  `proxy:view:folder/${ROUTE_FOLDER}`,
  `proxy:create:folder/${ROUTE_FOLDER}`,
];

async function folderScopes() {
  return expandFolderScopes(testDb() as never, FOLDER_GRANTS);
}

function registerOAuth(scopes: string[]) {
  const user: User = { ...USER, scopes: ['mcp:use', ...scopes] };
  container.registerInstance(OAuthService, {
    getMcpResourceUrl: vi.fn().mockReturnValue('https://gateway.example.com/api/mcp'),
    getApiResourceUrl: vi.fn().mockReturnValue('https://gateway.example.com/api'),
    getProtectedResourceMetadataUrl: vi.fn().mockReturnValue('https://gateway.example.com/.well-known/x'),
    validateAccessToken: vi
      .fn()
      .mockResolvedValue({ user, scopes, tokenId: 'oauth-token-1', tokenPrefix: 'gwo_abc123', clientId: 'goc_client' }),
  } as unknown as OAuthService);
}

async function mcpRequest(method: string, params: Record<string, unknown> = {}) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  app.route('/api/mcp', mcpRoutes);
  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer gwo_valid',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const messages = (response.headers.get('content-type') ?? '').includes('application/json')
    ? [JSON.parse(text)].flat()
    : text.split(/\n\n+/).flatMap((event) =>
        event
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice('data: '.length)))
      );
  return messages.find((message: { id?: number }) => message.id === 1) as Record<string, any>;
}

const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'test-agent', version: '1.0.0' },
};

beforeEach(() => {
  container.registerInstance(McpSettingsService, {
    getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
  } as unknown as McpSettingsService);
  container.registerInstance(TOKENS.DrizzleClient, testDb());
  container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as never);
});

afterEach(() => {
  resetMcpDiscoveryStateForTests();
  container.reset();
});

describe('MCP connect-time access summary', () => {
  it('adds a short summary of folder-limited access to the server instructions', async () => {
    registerOAuth(await folderScopes());

    const body = await mcpRequest('initialize', INITIALIZE);
    const instructions: string = body.result.instructions;

    expect(instructions.startsWith(MCP_SERVER_INSTRUCTIONS)).toBe(true);
    expect(instructions).toContain('Your Gateway access is limited to specific folders, nodes or resources.');
    expect(instructions).toContain(
      "- Docker containers and deployments: folder 'MyProject' (create, view); create only in the folders or nodes listed."
    );
    expect(instructions).toContain("- Ingress routes: folder 'MyProject routes' (create, view)");
    expect(instructions).toContain('Call get_my_access (or read gateway://access)');
    expect(instructions).toContain('pass folderId (and nodeId) when creating');
    expect(instructions.length).toBeLessThan(MCP_SERVER_INSTRUCTIONS.length + 1600);
  });

  it('keeps the plain instructions for broad access', async () => {
    registerOAuth(['proxy:view', 'proxy:create', 'nodes:details']);

    const body = await mcpRequest('initialize', INITIALIZE);

    expect(body.result.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get_my_access');
  });

  it('serves the access summary as gateway://access', async () => {
    registerOAuth(await folderScopes());

    const list = await mcpRequest('resources/list');
    expect(list.result.resources.map((resource: { uri: string }) => resource.uri)).toContain(MCP_ACCESS_RESOURCE_URI);

    const read = await mcpRequest('resources/read', { uri: MCP_ACCESS_RESOURCE_URI });
    const summary = JSON.parse(read.result.contents[0].text);
    expect(summary.principal).toMatchObject({ userId: USER.id, credential: 'mcp', boundedByOwner: true });
    expect(summary.limited).toBe(true);
    expect(summary.areas.find((area: { area: string }) => area.area === 'routes')).toMatchObject({
      access: 'limited',
      folders: [{ id: ROUTE_FOLDER, name: 'MyProject routes', actions: ['create', 'view'] }],
      resources: [],
      create: { atRoot: false, folders: [{ id: ROUTE_FOLDER }] },
    });
  });
});

describe('get_my_access and limited-access denials over MCP', () => {
  async function connect(scopes: string[]) {
    const account: User = { ...USER, scopes };
    container.registerInstance(
      AIService,
      createService({
        nodesService: {},
        proxyService: {
          getProxyHost: vi.fn().mockResolvedValue({ id: ROUTE_IN }),
        },
        authService: { getUserById: vi.fn().mockResolvedValue(account) },
        auditService: { log: vi.fn().mockResolvedValue(undefined) },
      })
    );
    const handlers = new Map<unknown, (request: unknown, extra: unknown) => Promise<any>>();
    const server = {
      server: {
        registerCapabilities: vi.fn(),
        setRequestHandler: (schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) =>
          handlers.set(schema, handler),
      },
    };
    registerMcpToolHandlers(
      server as never,
      { server: server as never, scopes, tokenId: 'token-1', tokenPrefix: 'gwo_1', authType: 'oauth' },
      account
    );
    return {
      async toolNames(): Promise<string[]> {
        const result = await handlers.get(ListToolsRequestSchema)!({ params: {} }, {});
        return result.tools.map((tool: { name: string }) => tool.name);
      },
      async call(name: string, args: Record<string, unknown>) {
        const result = await handlers.get(CallToolRequestSchema)!(
          { params: { name, arguments: args } },
          { sendNotification: vi.fn() }
        );
        const text = result.content[0]?.text ?? '';
        return result.isError ? { error: text as string } : { result: JSON.parse(text) };
      },
    };
  }

  it('offers get_my_access without toolset discovery and returns the bounded summary', async () => {
    const mcp = await connect(await folderScopes());

    expect(await mcp.toolNames()).toContain('get_my_access');
    const all = await mcp.call('get_my_access', {});
    expect(all.error).toBeUndefined();
    expect(all.result).toMatchObject({
      principal: { credential: 'mcp', boundedByOwner: true },
      limited: true,
    });
    expect(all.result.areas.map((area: { area: string }) => area.area)).toEqual(['docker_containers', 'routes']);

    const docker = await mcp.call('get_my_access', { area: 'docker_containers' });
    expect(docker.result.areas).toEqual([
      expect.objectContaining({
        area: 'docker_containers',
        folders: [expect.objectContaining({ id: FOLDER, name: 'MyProject', actions: ['create', 'view'] })],
        create: expect.objectContaining({ atRoot: false, folders: [expect.objectContaining({ id: FOLDER })] }),
      }),
    ]);
  });

  it('names the granted folders when a visible tool is called on a target outside them', async () => {
    const mcp = await connect(await folderScopes());

    const outside = await mcp.call('get_route', { routeId: ROUTE_OUT });
    expect(outside.error).toContain('unavailable for this MCP token');
    expect(outside.error).toContain(
      `Your proxy:view access is limited to folder 'MyProject routes' (${ROUTE_FOLDER}) (and what they contain)`
    );
    expect(outside.error).toContain('get_my_access');
  });
});

describe('get_my_access and limited-access denials in the in-product assistant', () => {
  async function assistant() {
    const account: User = { ...USER, scopes: [...(await folderScopes()), 'ai:workspace:use'] };
    const service = createService({
      nodesService: {},
      authService: { getUserById: vi.fn().mockResolvedValue(account) },
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
    });
    return { service, account };
  }

  it("returns the user's own access summary", async () => {
    const { service, account } = await assistant();
    const outcome = await service.executeTool(account, 'get_my_access', {}, { source: 'ai' });

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toMatchObject({
      principal: { userId: USER.id, credential: 'assistant', boundedByOwner: false },
      limited: true,
    });
  });

  it('tells a folder-limited user where the scope is held instead of "contact an administrator"', async () => {
    const { service, account } = await assistant();
    const outcome = await service.executeTool(account, 'get_route', { routeId: ROUTE_OUT }, { source: 'ai' });

    expect(outcome.error).toBe(
      `PERMISSION_DENIED: "proxy:view" is not granted for this target. Your proxy:view access is limited to folder 'MyProject routes' (${ROUTE_FOLDER}) (and what they contain): act on resources inside them, which the list tools return. Call get_my_access for details.`
    );
  });
});
