import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { daemonLogRelay, resetNginxLogHistoryForTest } from '@/modules/monitoring/log-relay.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { AIService } from './ai.service.js';
import { isImpersonationBlockedToolCall } from './ai-impersonation-policy.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService(nodesService: Record<string, unknown>) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    nodesService as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('AIService node tool routing', () => {
  it('lists nodes through compact agent-safe rows and scoped allowed ids', async () => {
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'node-1',
            type: 'docker',
            hostname: 'docker-1.internal',
            displayName: 'Docker 1',
            status: 'online',
            isConnected: true,
            serviceCreationLocked: false,
            daemonVersion: '1.2.3',
            osInfo: 'linux',
            configVersionHash: 'hash-1',
            capabilities: { docker: true },
            lastSeenAt: '2026-06-01T00:00:00.000Z',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
            enrollmentToken: 'must-not-leak',
          },
        ],
        page: 2,
        limit: 10,
        total: 1,
      }),
    };
    const service = createService(nodesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:details:node-1'] }, 'list_nodes', {
        search: 'docker',
        type: 'docker',
        status: 'online',
        page: 2,
        limit: 10,
      })
    ).resolves.toEqual({
      result: {
        data: [
          {
            id: 'node-1',
            type: 'docker',
            hostname: 'docker-1.internal',
            displayName: 'Docker 1',
            status: 'online',
            isConnected: true,
            serviceCreationLocked: false,
            daemonVersion: '1.2.3',
            osInfo: 'linux',
            configVersionHash: 'hash-1',
            capabilities: { docker: true },
            lastSeenAt: '2026-06-01T00:00:00.000Z',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        page: 2,
        limit: 10,
        total: 1,
      },
      invalidateStores: [],
    });
    expect(nodesService.list).toHaveBeenCalledWith(
      { search: 'docker', type: 'docker', status: 'online', page: 2, limit: 10 },
      { allowedIds: ['node-1'] }
    );
  });

  it('routes node reads and mutations to the node service', async () => {
    const nodesService = {
      get: vi.fn().mockResolvedValue({ id: 'node-1' }),
      create: vi.fn().mockResolvedValue({ id: 'node-2' }),
      update: vi.fn().mockResolvedValue({ id: 'node-1', displayName: 'Proxy' }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(nodesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:details:node-1'] }, 'get_node', { nodeId: 'node-1' })
    ).resolves.toEqual({ result: { id: 'node-1' }, invalidateStores: [] });
    expect(nodesService.get).toHaveBeenCalledWith('node-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:create'] }, 'create_node', {
        hostname: 'proxy-1.internal',
        displayName: 'Proxy 1',
      })
    ).resolves.toEqual({ result: { id: 'node-2' }, invalidateStores: ['nodes'] });
    expect(nodesService.create).toHaveBeenCalledWith(
      { hostname: 'proxy-1.internal', type: 'nginx', displayName: 'Proxy 1' },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:rename:node-1'] }, 'rename_node', {
        nodeId: 'node-1',
        displayName: 'Proxy',
      })
    ).resolves.toEqual({ result: { id: 'node-1', displayName: 'Proxy' }, invalidateStores: ['nodes'] });
    expect(nodesService.update).toHaveBeenCalledWith('node-1', { displayName: 'Proxy' }, 'user-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:delete:node-1'] }, 'delete_node', { nodeId: 'node-1' })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['nodes'] });
    expect(nodesService.remove).toHaveBeenCalledWith('node-1', 'user-1', { cascadeOfflineProxyHosts: false });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:delete:node-1'] }, 'delete_node', {
        nodeId: 'node-1',
        cascadeProxyHosts: true,
      })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(nodesService.remove).toHaveBeenLastCalledWith('node-1', 'user-1', { cascadeOfflineProxyHosts: true });
  });

  it('reads, updates, and tests node nginx config through the node dispatch service', async () => {
    const dispatchService = {
      readGlobalConfig: vi.fn().mockResolvedValue({ success: true, detail: 'events {}' }),
      updateGlobalConfig: vi.fn().mockResolvedValue({ success: true }),
      testConfig: vi.fn().mockResolvedValue({ success: true, detail: 'nginx: syntax is ok' }),
    };
    const resolveSpy = vi.spyOn(container, 'resolve').mockImplementation((token) => {
      if (token === NodeDispatchService) return dispatchService as never;
      throw new Error('Unexpected container resolve');
    });
    const service = createService({});

    try {
      await expect(
        service.executeTool({ ...BASE_USER, scopes: ['nodes:config:view:node-1'] }, 'manage_node_config', {
          operation: 'read',
          nodeId: 'node-1',
        })
      ).resolves.toEqual({ result: { nodeId: 'node-1', content: 'events {}' }, invalidateStores: ['nodes'] });
      expect(dispatchService.readGlobalConfig).toHaveBeenCalledWith('node-1');

      await expect(
        service.executeTool({ ...BASE_USER, scopes: ['nodes:config:edit:node-1'] }, 'manage_node_config', {
          operation: 'update',
          nodeId: 'node-1',
          content: 'events { worker_connections 1024; }',
        })
      ).resolves.toEqual({ result: { nodeId: 'node-1', valid: true, error: null }, invalidateStores: ['nodes'] });
      expect(dispatchService.updateGlobalConfig).toHaveBeenCalledWith(
        'node-1',
        'events { worker_connections 1024; }',
        ''
      );

      await expect(
        service.executeTool({ ...BASE_USER, scopes: ['nodes:config:edit:node-1'] }, 'manage_node_config', {
          operation: 'test',
          nodeId: 'node-1',
        })
      ).resolves.toEqual({
        result: { nodeId: 'node-1', valid: true, output: 'nginx: syntax is ok', error: null },
        invalidateStores: ['nodes'],
      });
      expect(dispatchService.testConfig).toHaveBeenCalledWith('node-1');
    } finally {
      resolveSpy.mockRestore();
    }
  });
});

describe('AIService node parity tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetNginxLogHistoryForTest();
  });

  it('creates relay nodes with the route schema and folder destination rules', async () => {
    const nodesService = { create: vi.fn().mockResolvedValue({ node: { id: NODE_ID } }) };
    const folderService = { assertFolderExists: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(container, 'resolve').mockImplementation((token) => {
      if (token === NodeFolderService) return folderService as never;
      throw new Error('Unexpected container resolve');
    });
    const service = createService(nodesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['nodes:create'] }, 'create_node', {
        hostname: 'relay-1.internal',
        type: 'relay',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Relay nodes require at least one advertised') });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:create:folder/${FOLDER_ID}`] }, 'create_node', {
        hostname: 'relay-1.internal',
        type: 'relay',
        serviceAddresses: ['203.0.113.10'],
        servicePort: 7443,
        folderId: '33333333-3333-4333-8333-333333333333',
      })
    ).resolves.toMatchObject({ error: 'Missing nodes:create permission for the selected destination' });
    expect(nodesService.create).not.toHaveBeenCalled();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:create:folder/${FOLDER_ID}`] }, 'create_node', {
        hostname: 'relay-1.internal',
        type: 'relay',
        serviceAddresses: ['203.0.113.10'],
        servicePort: 7443,
        folderId: FOLDER_ID,
      })
    ).resolves.toEqual({ result: { node: { id: NODE_ID } }, invalidateStores: ['nodes'] });
    expect(folderService.assertFolderExists).toHaveBeenCalledWith(FOLDER_ID);
    expect(nodesService.create).toHaveBeenCalledWith(
      {
        type: 'relay',
        hostname: 'relay-1.internal',
        folderId: FOLDER_ID,
        serviceAddresses: ['203.0.113.10'],
        servicePort: 7443,
      },
      'user-1'
    );
  });

  it('updates node fields with the per-field permissions of PATCH /nodes/{id}', async () => {
    const nodesService = {
      get: vi.fn().mockResolvedValue({ id: NODE_ID, type: 'nginx' }),
      update: vi.fn().mockResolvedValue({ id: NODE_ID, displayName: 'Edge' }),
    };
    const service = createService(nodesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:details:${NODE_ID}`] }, 'manage_node', {
        operation: 'update',
        nodeId: NODE_ID,
        displayName: 'Edge',
      })
    ).resolves.toMatchObject({ error: 'Editing node identity or service addresses requires node rename access' });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:rename:${NODE_ID}`] }, 'manage_node', {
        operation: 'update',
        nodeId: NODE_ID,
        serviceAddresses: ['198.51.100.7'],
      })
    ).resolves.toMatchObject({ error: 'Editing the Nginx service address requires node config edit access' });
    expect(nodesService.update).not.toHaveBeenCalled();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:rename:${NODE_ID}`] }, 'manage_node', {
        operation: 'update',
        nodeId: NODE_ID,
        displayName: 'Edge',
        appearanceColor: 'green',
      })
    ).resolves.toEqual({ result: { id: NODE_ID, displayName: 'Edge' }, invalidateStores: ['nodes'] });
    expect(nodesService.update).toHaveBeenCalledWith(
      NODE_ID,
      { displayName: 'Edge', appearanceColor: 'green' },
      'user-1'
    );
  });

  it('rejects a node update without fields instead of skipping every per-field check', async () => {
    const nodesService = {
      get: vi.fn().mockResolvedValue({ id: NODE_ID, type: 'nginx' }),
      update: vi.fn().mockResolvedValue({ id: NODE_ID }),
    };
    const service = createService(nodesService);

    for (const fields of [{}, { confirmDomainDnsUpdate: true }]) {
      await expect(
        service.executeTool({ ...BASE_USER, scopes: [`nodes:logs:${NODE_ID}`] }, 'manage_node', {
          operation: 'update',
          nodeId: NODE_ID,
          ...fields,
        })
      ).resolves.toMatchObject({ error: 'Provide at least one node field to update' });
    }
    expect(nodesService.update).not.toHaveBeenCalled();
  });

  it('regenerates an enrollment token only with nodes:create on the node and never while impersonating', async () => {
    const nodesService = {
      regenerateEnrollmentToken: vi.fn().mockResolvedValue({ enrollmentToken: 'gw_enroll_new' }),
    };
    const service = createService(nodesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:details:${NODE_ID}`] }, 'manage_node', {
        operation: 'regenerate_enrollment_token',
        nodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ error: `PERMISSION_DENIED: Missing required scope nodes:create:${NODE_ID}` });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:create:${NODE_ID}`] }, 'manage_node', {
        operation: 'regenerate_enrollment_token',
        nodeId: NODE_ID,
      })
    ).resolves.toEqual({ result: { enrollmentToken: 'gw_enroll_new' }, invalidateStores: ['nodes'] });
    expect(nodesService.regenerateEnrollmentToken).toHaveBeenCalledWith(NODE_ID, 'user-1');
    expect(
      isImpersonationBlockedToolCall('manage_node', { operation: 'regenerate_enrollment_token', nodeId: NODE_ID })
    ).toBe(true);
    expect(isImpersonationBlockedToolCall('manage_node', { operation: 'health_history', nodeId: NODE_ID })).toBe(false);
  });

  it('reads health history and filtered daemon logs with the node detail and log grants', async () => {
    const nodesService = { getHealthHistory: vi.fn().mockResolvedValue([{ status: 'online' }]) };
    const service = createService(nodesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:details:${NODE_ID}`] }, 'manage_node', {
        operation: 'health_history',
        nodeId: NODE_ID,
      })
    ).resolves.toEqual({
      result: { nodeId: NODE_ID, healthHistory: [{ status: 'online' }] },
      invalidateStores: ['nodes'],
    });

    const base = { nodeId: NODE_ID, component: 'agent', fields: {} };
    daemonLogRelay.emit('log', { ...base, timestamp: '2026-09-24T10:00:00Z', level: 'info', message: 'started' });
    daemonLogRelay.emit('log', { ...base, timestamp: '2026-09-24T10:00:01Z', level: 'error', message: 'disk full' });
    daemonLogRelay.emit('log', { ...base, timestamp: '2026-09-24T10:00:02Z', level: 'error', message: 'retrying' });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`nodes:details:${NODE_ID}`] }, 'manage_node', {
        operation: 'daemon_logs',
        nodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ error: `PERMISSION_DENIED: Missing required scope nodes:logs:${NODE_ID}` });

    const result = await service.executeTool({ ...BASE_USER, scopes: [`nodes:logs:${NODE_ID}`] }, 'manage_node', {
      operation: 'daemon_logs',
      nodeId: NODE_ID,
      levels: ['ERROR'],
      search: 'disk',
    });
    expect(result.result).toMatchObject({ nodeId: NODE_ID, count: 1, entries: [{ message: 'disk full' }] });
  });
});
