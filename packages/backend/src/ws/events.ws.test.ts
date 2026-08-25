import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { TOOL_STORE_INVALIDATION_CHANNEL_PREFIX } from '@/modules/ai/ai-tool-store-invalidation.js';
import { apiTokenChangedChannel } from '@/modules/auth/user-resource-events.js';
import { INFERENCE_USAGE_CHANGED_CHANNEL } from '@/modules/inference/accounting/inference-usage-events.js';
import { INFERENCE_SETUP_EVENT_CHANNEL } from '@/modules/inference/inference-setup-events.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';

const mocks = vi.hoisted(() => ({
  resolveLiveSessionUser: vi.fn(),
  resolveLiveUser: vi.fn(),
}));

vi.mock('@/modules/auth/live-session-user.js', () => ({
  resolveLiveSessionUser: mocks.resolveLiveSessionUser,
  resolveLiveUser: mocks.resolveLiveUser,
}));

import { authenticateEventsConnection, createEventsWSHandlers } from './events.ws.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['nodes:details'],
  isBlocked: false,
};

function createWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  container.reset();
});

describe('events websocket authentication', () => {
  it('delivers personal resource changes only to the owning user session', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({ user: USER, effectiveScopes: [] });
    const ws = createWs();
    const handlers = createEventsWSHandlers();
    const ownChannel = apiTokenChangedChannel(USER.id);
    const otherChannel = apiTokenChangedChannel('22222222-2222-4222-8222-222222222222');

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: [ownChannel, otherChannel] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: [ownChannel], rejected: [otherChannel] })
    );
    eventBus.publish(ownChannel, { action: 'update', id: 'token-1' });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'event', channel: ownChannel, payload: { action: 'update', id: 'token-1' } })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers tool invalidations only to the owning user session', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({ user: USER, effectiveScopes: [] });
    const ws = createWs();
    const handlers = createEventsWSHandlers();
    const ownChannel = `${TOOL_STORE_INVALIDATION_CHANNEL_PREFIX}${USER.id}`;
    const otherChannel = `${TOOL_STORE_INVALIDATION_CHANNEL_PREFIX}22222222-2222-4222-8222-222222222222`;

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: [ownChannel, otherChannel] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: [ownChannel], rejected: [otherChannel] })
    );
    eventBus.publish(ownChannel, { stores: ['containers'] });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'event', channel: ownChannel, payload: { stores: ['containers'] } })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers an MFA requirement event only to its target user', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({ user: USER, effectiveScopes: USER.scopes });
    const ws = createWs();
    const handlers = createEventsWSHandlers();
    const ownChannel = `mfa.required.${USER.id}`;
    const otherChannel = 'mfa.required.22222222-2222-4222-8222-222222222222';

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: [ownChannel, otherChannel] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: [ownChannel], rejected: [otherChannel] })
    );

    eventBus.publish(ownChannel, { groupId: 'group-1', requireGateway2fa: true });
    eventBus.publish(otherChannel, { groupId: 'group-2', requireGateway2fa: true });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: ownChannel,
        payload: { groupId: 'group-1', requireGateway2fa: true },
      })
    );
    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('group-2'));

    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers inference usage invalidations only to the affected user', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['feat:ai:use'] },
      effectiveScopes: ['feat:ai:use'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: [INFERENCE_USAGE_CHANGED_CHANNEL] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribed',
        channels: [INFERENCE_USAGE_CHANGED_CHANNEL],
        rejected: [],
      })
    );

    eventBus.publish(INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: '22222222-2222-4222-8222-222222222222',
      reason: 'limits',
    });
    eventBus.publish(INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: USER.id,
      reason: 'limits',
    });
    eventBus.publish(INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: null,
      reason: 'limits',
    });

    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('22222222-2222-4222-8222-222222222222'));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: INFERENCE_USAGE_CHANGED_CHANNEL,
        payload: { targetUserId: USER.id, reason: 'limits' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: INFERENCE_USAGE_CHANGED_CHANNEL,
        payload: { targetUserId: null, reason: 'limits' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers all inference usage invalidations to usage administrators', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['inference:usage:view'] },
      effectiveScopes: ['inference:usage:view'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: [INFERENCE_USAGE_CHANGED_CHANNEL] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribed',
        channels: [INFERENCE_USAGE_CHANGED_CHANNEL],
        rejected: [],
      })
    );
    eventBus.publish(INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: '22222222-2222-4222-8222-222222222222',
      reason: 'settlement',
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: INFERENCE_USAGE_CHANGED_CHANNEL,
        payload: {
          targetUserId: '22222222-2222-4222-8222-222222222222',
          reason: 'settlement',
        },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('authorizes catalog invalidations for AI Workspace users', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['ai:workspace:use'] },
      effectiveScopes: ['ai:workspace:use'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: [INFERENCE_SETUP_EVENT_CHANNEL] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: [INFERENCE_SETUP_EVENT_CHANNEL], rejected: [] })
    );
    eventBus.publish(INFERENCE_SETUP_EVENT_CHANNEL, { id: 'catalog-1', type: 'catalog.changed' });
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('catalog-1'));
    handlers.onClose(new Event('close'), ws as any);
  });

  it('uses detailed notification view scopes for their matching event channels', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['notifications:alerts:view'] },
      effectiveScopes: ['notifications:alerts:view'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'subscribe',
          channels: ['notification.alert-rule.changed', 'notification.webhook.changed'],
        }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribed',
        channels: ['notification.alert-rule.changed'],
        rejected: ['notification.webhook.changed'],
      })
    );
    eventBus.publish('notification.alert-rule.changed', { id: 'alert-1', action: 'updated' });
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('alert-1'));
    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers logging-health updates to housekeeping viewers', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['housekeeping:view'] },
      effectiveScopes: ['housekeeping:view'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['logging.health.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['logging.health.changed'], rejected: [] })
    );
    eventBus.publish('logging.health.changed', { status: 'pressure', reason: 'Disk capacity' });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'logging.health.changed',
        payload: { status: 'pressure', reason: 'Disk capacity' },
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers relay-health invalidations to every authenticated user', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: [] },
      effectiveScopes: [],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['system.relay.health.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['system.relay.health.changed'], rejected: [] })
    );
    eventBus.publish('system.relay.health.changed', { state: 'critical' });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'system.relay.health.changed',
        payload: { state: 'critical' },
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers migration events with view access to the stable migrated resource', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: {
        ...USER,
        scopes: ['docker:containers:view:node-2/resource-visible'],
      },
      effectiveScopes: ['docker:containers:view:node-2/resource-visible'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['docker.migration.changed'] }),
      }),
      ws as any
    );

    eventBus.publish('docker.migration.changed', {
      id: 'migration-hidden',
      sourceNodeId: 'node-1',
      targetNodeId: 'node-3',
      scopeResourceId: 'resource-hidden',
      status: 'running',
    });
    eventBus.publish('docker.migration.changed', {
      id: 'migration-visible',
      sourceNodeId: 'node-1',
      targetNodeId: 'node-2',
      scopeResourceId: 'resource-visible',
      status: 'running',
    });

    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('migration-hidden'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('migration-visible'));
    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters Docker snapshot events by resource kind and node scope', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:images:view:node-1'] },
      effectiveScopes: ['docker:images:view:node-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['docker.snapshot.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['docker.snapshot.changed'], rejected: [] })
    );
    eventBus.publish('docker.snapshot.changed', { nodeId: 'node-1', kind: 'containers', revision: 1 });
    eventBus.publish('docker.snapshot.changed', { nodeId: 'node-2', kind: 'images', revision: 1 });
    eventBus.publish('docker.snapshot.changed', { nodeId: 'node-1', kind: 'images', revision: 2 });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'docker.snapshot.changed',
        payload: { nodeId: 'node-1', kind: 'images', revision: 2 },
      })
    );
    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('"kind":"containers"'));
    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('"nodeId":"node-2"'));
    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers Docker folder changes for a node containing an accessible child resource', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:containers:view:node-1/resource-1'] },
      effectiveScopes: ['docker:containers:view:node-1/resource-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['docker.folder.changed'] }),
      }),
      ws as any
    );

    eventBus.publish('docker.folder.changed', { nodeIds: ['node-2'] });
    eventBus.publish('docker.folder.changed', { nodeIds: ['node-1'] });

    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('node-2'));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'docker.folder.changed',
        payload: { nodeIds: ['node-1'] },
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters Compose project events by project-scoped view access', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:compose:view:node-1/project-1'] },
      effectiveScopes: ['docker:compose:view:node-1/project-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['docker.compose.changed'] }),
      }),
      ws as any
    );

    eventBus.publish('docker.compose.changed', { nodeId: 'node-1', projectId: 'project-2' });
    eventBus.publish('docker.compose.changed', { nodeId: 'node-1', projectId: 'project-1' });

    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('project-2'));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'docker.compose.changed',
        payload: { nodeId: 'node-1', projectId: 'project-1' },
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('rejects blocked session users', async () => {
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, isBlocked: true },
      effectiveScopes: USER.scopes,
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onClose(new Event('close'), ws as any);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'unauthenticated' }));
    expect(ws.close).toHaveBeenCalledWith(4001, 'unauthenticated');
  });

  it('filters CA change events by CA type view scope', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['pki:ca:view:intermediate'] },
      effectiveScopes: ['pki:ca:view:intermediate'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['ca.changed'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['ca.changed'], rejected: [] })
    );

    eventBus.publish('ca.changed', { id: 'root-1', action: 'updated', type: 'root' });
    eventBus.publish('ca.changed', { id: 'int-1', action: 'updated', type: 'intermediate' });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'ca.changed',
        payload: { id: 'root-1', action: 'updated', type: 'root' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'ca.changed',
        payload: { id: 'int-1', action: 'updated', type: 'intermediate' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('rejects unknown and unmapped event channels by default', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: USER,
      effectiveScopes: USER.scopes,
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'subscribe',
          channels: ['unmapped.channel', 'logging.environment.changed', 'system.update.changed'],
        }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribed',
        channels: ['system.update.changed'],
        rejected: ['unmapped.channel', 'logging.environment.changed'],
      })
    );

    eventBus.publish('system.update.changed', { updating: true, targetVersion: 'v2.4.0' });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'system.update.changed',
        payload: { updating: true, targetVersion: 'v2.4.0' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('replays an active Gateway update to clients that subscribe after it started', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: USER,
      effectiveScopes: USER.scopes,
    });
    eventBus.publish('system.update.changed', { updating: true, targetVersion: 'v2.4.0' });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['system.update.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'system.update.changed',
        payload: { updating: true, targetVersion: 'v2.4.0' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers configuration invalidations to an authenticated user without configuration payload', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({ user: USER, effectiveScopes: USER.scopes });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['system.config.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['system.config.changed'], rejected: [] })
    );
    eventBus.publish('system.config.changed', {});
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'event', channel: 'system.config.changed', payload: {} })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters logging events by environment-scoped log access', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['logs:read:env-1'] },
      effectiveScopes: ['logs:read:env-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['logging.logs.ingested'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['logging.logs.ingested'], rejected: [] })
    );

    eventBus.publish('logging.logs.ingested', { environmentId: 'env-2', count: 5 });
    eventBus.publish('logging.logs.ingested', { environmentId: 'env-1', count: 1 });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'logging.logs.ingested',
        payload: { environmentId: 'env-2', count: 5 },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'logging.logs.ingested',
        payload: { environmentId: 'env-1', count: 1 },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('allows integration connector events for GitLab integration viewers', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['integrations:gitlab:view'] },
      effectiveScopes: ['integrations:gitlab:view'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['integration.connector.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['integration.connector.changed'], rejected: [] })
    );

    eventBus.publish('integration.connector.changed', {
      id: 'connector-1',
      provider: 'gitlab',
      action: 'synced',
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'integration.connector.changed',
        payload: { id: 'connector-1', provider: 'gitlab', action: 'synced' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it.each([
    'integrations:github:view',
    'integrations:git:manage',
    'integrations:ssh:view',
  ])('allows integration connector events for %s', async (scope) => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: [scope] },
      effectiveScopes: [scope],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['integration.connector.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['integration.connector.changed'], rejected: [] })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('allows integration connector events for Cloudflare viewers', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['integrations:cloudflare:view'] },
      effectiveScopes: ['integrations:cloudflare:view'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['integration.connector.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['integration.connector.changed'], rejected: [] })
    );

    eventBus.publish('integration.connector.changed', {
      id: 'connector-1',
      provider: 'cloudflare',
      action: 'synced',
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'integration.connector.changed',
        payload: { id: 'connector-1', provider: 'cloudflare', action: 'synced' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters docker file events by node-scoped file access', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:containers:files:read:node-1'] },
      effectiveScopes: ['docker:containers:files:read:node-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['docker.file.changed'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['docker.file.changed'], rejected: [] })
    );

    eventBus.publish('docker.file.changed', {
      nodeId: 'node-2',
      containerId: 'container-1',
      action: 'created',
      path: '/tmp/other.txt',
      parentPath: '/tmp',
    });
    eventBus.publish('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'created',
      path: '/tmp/app.txt',
      parentPath: '/tmp',
    });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'docker.file.changed',
        payload: {
          nodeId: 'node-2',
          containerId: 'container-1',
          action: 'created',
          path: '/tmp/other.txt',
          parentPath: '/tmp',
        },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'docker.file.changed',
        payload: {
          nodeId: 'node-1',
          containerId: 'container-1',
          action: 'created',
          path: '/tmp/app.txt',
          parentPath: '/tmp',
        },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters Docker build events by the target resource scope', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:containers:view:node-1/api'] },
      effectiveScopes: ['docker:containers:view:node-1/api'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['docker.build.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['docker.build.changed'], rejected: [] })
    );

    eventBus.publish('docker.build.changed', {
      buildId: 'build-other',
      nodeId: 'node-1',
      scopeResourceId: 'other',
      status: 'building',
    });
    eventBus.publish('docker.build.changed', {
      buildId: 'build-api',
      nodeId: 'node-1',
      scopeResourceId: 'api',
      status: 'building',
    });

    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('build-other'));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'docker.build.changed',
        payload: {
          buildId: 'build-api',
          nodeId: 'node-1',
          scopeResourceId: 'api',
          status: 'building',
        },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters node changes for Docker-scoped users to their Docker node', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:volumes:files:write:node-1'] },
      effectiveScopes: ['docker:volumes:files:write:node-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['node.slug.changed', 'node.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['node.slug.changed', 'node.changed'], rejected: [] })
    );

    eventBus.publish('node.slug.changed', { id: 'node-2', oldSlug: 'old-2', slug: 'new-2' });
    eventBus.publish('node.slug.changed', { id: 'node-1', oldSlug: 'old-1', slug: 'new-1' });
    eventBus.publish('node.changed', { id: 'node-1', hostname: 'private-host' });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'node.slug.changed',
        payload: { id: 'node-2', oldSlug: 'old-2', slug: 'new-2' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'node.slug.changed',
        payload: { id: 'node-1', oldSlug: 'old-1', slug: 'new-1' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'node.changed',
        payload: { id: 'node-1', hostname: 'private-host' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('delivers Docker runtime progress without publishing a global node change', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({ user: USER, effectiveScopes: USER.scopes });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['docker.runtime.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['docker.runtime.changed'], rejected: [] })
    );

    const payload = {
      nodeId: 'node-1',
      status: { state: 'installing', step: 'downloading', progressPercent: 45 },
    };
    eventBus.publish('docker.runtime.changed', payload);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'event', channel: 'docker.runtime.changed', payload }));

    handlers.onClose(new Event('close'), ws as any);
  });

  it('allows broad Docker viewers to receive node slug changes', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['docker:images:view'] },
      effectiveScopes: ['docker:images:view'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['node.slug.changed'] }) }),
      ws as any
    );
    eventBus.publish('node.slug.changed', { id: 'node-2', oldSlug: 'old', slug: 'new' });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'node.slug.changed',
        payload: { id: 'node-2', oldSlug: 'old', slug: 'new' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('does not treat database credential reveal as database event visibility', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['databases:credentials:reveal:db-1'] },
      effectiveScopes: ['databases:credentials:reveal:db-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['database.changed'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: [], rejected: ['database.changed'] })
    );

    eventBus.publish('database.changed', { id: 'db-1', action: 'updated' });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'database.changed',
        payload: { id: 'db-1', action: 'updated' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('does not treat database delete as database event visibility', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['databases:delete:db-1'] },
      effectiveScopes: ['databases:delete:db-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['database.changed'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: [], rejected: ['database.changed'] })
    );

    eventBus.publish('database.changed', { id: 'db-1', action: 'deleted' });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'database.changed',
        payload: { id: 'db-1', action: 'deleted' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('lets proxy folder managers receive folder layout events without host visibility', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['proxy:folders:manage'] },
      effectiveScopes: ['proxy:folders:manage'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['proxy.host.changed'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['proxy.host.changed'], rejected: [] })
    );

    eventBus.publish('proxy.host.changed', { id: 'host-1', action: 'updated', domain: 'example.test' });
    eventBus.publish('proxy.host.changed', { action: 'folder_updated', folderId: 'folder-1' });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'proxy.host.changed',
        payload: { id: 'host-1', action: 'updated', domain: 'example.test' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'proxy.host.changed',
        payload: { action: 'folder_updated', folderId: 'folder-1' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('lets resource-scoped proxy viewers receive proxy folder layout events', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['proxy:view:host-1'] },
      effectiveScopes: ['proxy:view:host-1'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['proxy.host.changed'] }) }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['proxy.host.changed'], rejected: [] })
    );

    eventBus.publish('proxy.host.changed', { id: 'host-2', action: 'updated', domain: 'other.test' });
    eventBus.publish('proxy.host.changed', { action: 'hosts_moved', folderId: 'folder-1' });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'proxy.host.changed',
        payload: { id: 'host-2', action: 'updated', domain: 'other.test' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'event',
        channel: 'proxy.host.changed',
        payload: { action: 'hosts_moved', folderId: 'folder-1' },
      })
    );

    handlers.onClose(new Event('close'), ws as any);
  });

  it('filters Pages lifecycle events by Page Project ID', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['pages:view:project-visible'] },
      effectiveScopes: ['pages:view:project-visible'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['pages.deployment.changed'] }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribed', channels: ['pages.deployment.changed'], rejected: [] })
    );
    eventBus.publish('pages.deployment.changed', {
      id: 'hidden-deployment',
      scopeResourceId: 'project-hidden',
      action: 'ready',
    });
    eventBus.publish('pages.deployment.changed', {
      id: 'visible-deployment',
      scopeResourceId: 'project-visible',
      action: 'ready',
    });

    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('hidden-deployment'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('visible-deployment'));
    handlers.onClose(new Event('close'), ws as any);
  });

  it('keeps global Pages profile and folder events on their dedicated scopes', async () => {
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    mocks.resolveLiveSessionUser.mockResolvedValue({
      user: { ...USER, scopes: ['pages:folders:manage'] },
      effectiveScopes: ['pages:folders:manage'],
    });
    const ws = createWs();
    const handlers = createEventsWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    await authenticateEventsConnection(ws as any, 'session-1');
    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'subscribe',
          channels: ['pages.folder.changed', 'pages.profile.changed', 'pages.project.changed'],
        }),
      }),
      ws as any
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribed',
        channels: ['pages.folder.changed'],
        rejected: ['pages.profile.changed', 'pages.project.changed'],
      })
    );
    eventBus.publish('pages.folder.changed', { action: 'folders_reordered' });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'event', channel: 'pages.folder.changed', payload: { action: 'folders_reordered' } })
    );
    handlers.onClose(new Event('close'), ws as any);
  });
});
