import 'reflect-metadata';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, nodes } from '@/db/schema/index.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { getRegisteredDomainCandidates, type RegisteredDomainNode } from '@/modules/proxy/proxy-domain-node.js';
import type { User } from '@/types.js';
import { AIService, container, createService, ProxyService, USER } from './mcp-ai-audit.test-helpers.js';
import { listAvailableMcpTools, registerMcpToolHandlers } from './mcp-tools.js';

/**
 * A route creator without any node permission must create routes over MCP and in the assistant alike:
 * `nodeId` is optional when a registered domain pins the ingress node or only one node is eligible,
 * and `list_route_ingress_nodes` names the eligible nodes. The resolution runs for real (ProxyService
 * methods over a stand-in database); only the create itself is stubbed.
 */

const EDGE_1 = '11111111-1111-4111-8111-111111111111';
const EDGE_2 = '22222222-2222-4222-8222-222222222222';
const LOCKED = '33333333-3333-4333-8333-333333333333';
const FOLDER = '44444444-4444-4444-8444-444444444444';
const OTHER_FOLDER = '55555555-5555-4555-8555-555555555555';
const ROUTE_ID = '66666666-6666-4666-8666-666666666666';

const NODE_ROWS = [
  { id: EDGE_1, displayName: 'Edge One', hostname: 'edge-1', status: 'online', serviceCreationLocked: false },
  // Online in the database but its daemon is not connected: reported offline.
  { id: EDGE_2, displayName: null, hostname: 'edge-2', status: 'online', serviceCreationLocked: false },
  { id: LOCKED, displayName: 'Locked', hostname: 'edge-3', status: 'online', serviceCreationLocked: true },
];
const REGISTERED: RegisteredDomainNode[] = [
  { domain: 'app.example.com', nginxNodeId: EDGE_2 },
  { domain: '*.one.example.net', nginxNodeId: EDGE_1 },
];
const CONNECTED = new Set([EDGE_1, LOCKED]);

/** ProxyService's ingress resolution over a database holding NODE_ROWS and REGISTERED. */
function proxyServiceWithIngressData() {
  let requestedDomainNames: string[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === domains) {
          return {
            where: async () => {
              const candidates = new Set(getRegisteredDomainCandidates(requestedDomainNames));
              return REGISTERED.filter((row) => candidates.has(row.domain.toLowerCase()));
            },
          };
        }
        if (table === nodes) return { where: () => ({ orderBy: async () => NODE_ROWS.map((row) => ({ ...row })) }) };
        throw new Error('Unexpected table');
      },
    }),
  };
  const real = Object.assign(Object.create(ProxyService.prototype), {
    db,
    nodeDispatch: { isNodeConnected: (id: string) => CONNECTED.has(id) },
  }) as ProxyService;
  return {
    resolveRouteIngressNode: vi.fn((scopes: string[], input: { domainNames: string[] }) => {
      requestedDomainNames = input.domainNames;
      return real.resolveRouteIngressNode(scopes, input as never);
    }),
    listRouteIngressNodes: vi.fn((scopes: string[], folderId?: string) => real.listRouteIngressNodes(scopes, folderId)),
    createProxyHost: vi.fn(async (input: { nodeId: string; domainNames: string[]; folderId?: string }) => ({
      id: ROUTE_ID,
      slug: 'route',
      type: 'proxy',
      enabled: true,
      nodeId: input.nodeId,
      domainNames: input.domainNames,
      folderId: input.folderId ?? null,
    })),
    assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
  };
}

type Outcome = { result?: any; error?: string };
type Call = (name: string, args: Record<string, unknown>) => Promise<Outcome>;

function connectAssistant(scopes: string[], proxyService: Record<string, any>): Call {
  const user: User = { ...USER, scopes };
  const service = createService({
    nodesService: {},
    proxyService,
    authService: { getUserById: vi.fn().mockResolvedValue(user) },
    auditService: { log: vi.fn() },
  });
  return async (name, args) => {
    const outcome = await service.executeTool(user, name, args);
    return 'error' in outcome && outcome.error ? { error: outcome.error } : { result: outcome.result };
  };
}

function connectMcp(scopes: string[], proxyService: Record<string, any>): Call {
  const account: User = { ...USER, scopes };
  const service = createService({
    nodesService: {},
    proxyService,
    authService: { getUserById: vi.fn().mockResolvedValue(account) },
    auditService: { log: vi.fn().mockResolvedValue(undefined) },
  });
  container.registerInstance(AIService, service);
  const handlers = new Map<unknown, (request: unknown, extra: unknown) => Promise<unknown>>();
  const server = {
    server: {
      registerCapabilities: vi.fn(),
      setRequestHandler: (schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) =>
        handlers.set(schema, handler),
    },
  };
  registerMcpToolHandlers(
    server as never,
    {
      server: server as never,
      scopes,
      tokenId: 'token-ingress',
      tokenPrefix: 'gwo_ingress',
      authType: 'oauth',
      eagerToolListing: true,
    },
    account
  );
  return async (name, args) => {
    const response = (await handlers.get(CallToolRequestSchema)!(
      { params: { name, arguments: args } },
      { sendNotification: vi.fn() }
    )) as { isError?: boolean; content: Array<{ text: string }> };
    const text = response.content[0]?.text ?? '';
    return response.isError ? { error: text } : { result: JSON.parse(text) };
  };
}

const ROUTE = { forwardHost: 'app', forwardPort: 3000 };

beforeEach(() => {
  container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as never);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
    requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
});

describe.each([
  ['assistant', connectAssistant],
  ['MCP', connectMcp],
])('route ingress node selection through the %s', (_surface, connect) => {
  it('creates a route for a registered domain without nodeId holding only proxy:create', async () => {
    const proxyService = proxyServiceWithIngressData();
    const call = connect(['proxy:create'], proxyService);

    const created = await call('create_route', { ...ROUTE, domainNames: ['app.example.com'] });

    expect(created.error).toBeUndefined();
    expect(created.result).toMatchObject({ id: ROUTE_ID, nodeId: EDGE_2 });
    expect(proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: EDGE_2, domainNames: ['app.example.com'] }),
      USER.id,
      expect.objectContaining({ actorScopes: ['proxy:create'] })
    );
  });

  it('creates in a granted folder on the node of the registered domain, and not at the root', async () => {
    const proxyService = proxyServiceWithIngressData();
    const call = connect([`proxy:create:folder/${FOLDER}`], proxyService);

    await expect(
      call('create_route', { ...ROUTE, domainNames: ['api.one.example.net'], folderId: FOLDER })
    ).resolves.toMatchObject({ result: { nodeId: EDGE_1 } });
    expect(proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: EDGE_1, folderId: FOLDER }),
      USER.id,
      expect.anything()
    );

    const root = await call('create_route', { ...ROUTE, domainNames: ['api.one.example.net'] });
    expect(root.error).toContain(`served by Nginx ingress node ${EDGE_1}`);
    expect(proxyService.createProxyHost).toHaveBeenCalledTimes(1);
  });

  it('creates with a node grant on the pinned node or the only granted node, and refuses another node', async () => {
    const proxyService = proxyServiceWithIngressData();
    const call = connect([`proxy:create:node/${EDGE_1}`], proxyService);

    // No registered domain: the only node of the grant, which is connected.
    await expect(call('create_route', { ...ROUTE, domainNames: ['new.example.org'] })).resolves.toMatchObject({
      result: { nodeId: EDGE_1 },
    });
    await expect(call('create_route', { ...ROUTE, domainNames: ['api.one.example.net'] })).resolves.toMatchObject({
      result: { nodeId: EDGE_1 },
    });
    const elsewhere = await call('create_route', { ...ROUTE, domainNames: ['app.example.com'] });
    expect(elsewhere.error).toContain(`proxy:create:node/${EDGE_2}`);
    expect(proxyService.createProxyHost).toHaveBeenCalledTimes(2);
  });

  it('follows a registered domain to its node but never auto-picks a disconnected one', async () => {
    const proxyService = proxyServiceWithIngressData();
    const call = connect([`proxy:create:node/${EDGE_2}`], proxyService);

    await expect(call('create_route', { ...ROUTE, domainNames: ['app.example.com'] })).resolves.toMatchObject({
      result: { nodeId: EDGE_2 },
    });
    const unpinned = await call('create_route', { ...ROUTE, domainNames: ['new.example.org'] });
    expect(unpinned.error).toContain('is not connected');
    expect(proxyService.createProxyHost).toHaveBeenCalledTimes(1);
  });

  it('refuses an ambiguous route with the eligible ingress nodes listed', async () => {
    const proxyService = proxyServiceWithIngressData();
    const call = connect(['proxy:create'], proxyService);

    const ambiguous = await call('create_route', { ...ROUTE, domainNames: ['new.example.org'] });

    expect(ambiguous.error).toContain('nodeId is required');
    expect(ambiguous.error).toContain(`Edge One (edge-1): ${EDGE_1}, online`);
    expect(ambiguous.error).toContain(`edge-2: ${EDGE_2}, offline`);
    expect(ambiguous.error).not.toContain(LOCKED);
    expect(proxyService.createProxyHost).not.toHaveBeenCalled();

    // The explicit node still works and keeps the domain affinity check in the service.
    await expect(
      call('create_route', { ...ROUTE, domainNames: ['new.example.org'], nodeId: EDGE_1 })
    ).resolves.toMatchObject({ result: { nodeId: EDGE_1 } });
    expect(proxyService.resolveRouteIngressNode).toHaveBeenCalledTimes(1);
  });

  it('lists the eligible ingress nodes for each grant form without node details', async () => {
    const list = async (scopes: string[], args: Record<string, unknown> = {}) => {
      const outcome = await connect(scopes, proxyServiceWithIngressData())('list_route_ingress_nodes', args);
      expect(outcome.error).toBeUndefined();
      return outcome.result.data as Array<Record<string, unknown>>;
    };

    expect(await list(['proxy:create'])).toEqual([
      { id: EDGE_1, displayName: 'Edge One', hostname: 'edge-1', status: 'online' },
      { id: EDGE_2, displayName: null, hostname: 'edge-2', status: 'offline' },
    ]);
    expect((await list([`proxy:create:node/${EDGE_2}`])).map((node) => node.id)).toEqual([EDGE_2]);
    expect((await list([`proxy:create:${EDGE_1}`])).map((node) => node.id)).toEqual([EDGE_1]);
    expect((await list([`proxy:create:folder/${FOLDER}`])).map((node) => node.id)).toEqual([EDGE_1, EDGE_2]);
    expect((await list([`proxy:create:folder/${FOLDER}`], { folderId: FOLDER })).map((node) => node.id)).toEqual([
      EDGE_1,
      EDGE_2,
    ]);
    expect(await list([`proxy:create:folder/${FOLDER}`], { folderId: OTHER_FOLDER })).toEqual([]);
  });

  it('refuses the listing without a proxy:create grant', async () => {
    const outcome = await connect(['proxy:view', 'nodes:details'], proxyServiceWithIngressData())(
      'list_route_ingress_nodes',
      {}
    );
    expect(outcome.error).toBeDefined();
  });
});

describe('MCP route ingress node tool listing', () => {
  const names = (scopes: string[]) => listAvailableMcpTools(scopes).map((tool) => tool.name);

  it('advertises the ingress node listing to every proxy:create grant form and nobody else', () => {
    for (const scopes of [['proxy:create'], [`proxy:create:folder/${FOLDER}`], [`proxy:create:node/${EDGE_1}`]]) {
      expect(names(scopes)).toEqual(expect.arrayContaining(['create_route', 'list_route_ingress_nodes']));
    }
    expect(names(['proxy:view', 'nodes:details'])).not.toContain('list_route_ingress_nodes');
  });

  it('does not require nodeId on create_route', async () => {
    const createRoute = listAvailableMcpTools(['proxy:create']).find((tool) => tool.name === 'create_route');
    expect(createRoute?.parameters.required).toEqual(['domainNames']);

    const handlers = new Map<unknown, (request: unknown, extra: unknown) => Promise<unknown>>();
    registerMcpToolHandlers(
      {
        server: {
          registerCapabilities: vi.fn(),
          setRequestHandler: (schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) =>
            handlers.set(schema, handler),
        },
      } as never,
      { server: {} as never, scopes: ['proxy:create'], tokenId: 'token-list', eagerToolListing: true } as never,
      { ...USER, scopes: ['proxy:create'] }
    );
    const listed = (await handlers.get(ListToolsRequestSchema)!({ params: {} }, {})) as {
      tools: Array<{ name: string; inputSchema: { required?: string[] }; annotations: { readOnlyHint: boolean } }>;
    };
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('create_route')?.inputSchema.required).not.toContain('nodeId');
    expect(byName.get('list_route_ingress_nodes')?.annotations.readOnlyHint).toBe(true);
  });
});
