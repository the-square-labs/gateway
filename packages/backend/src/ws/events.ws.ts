import type { WSContext } from 'hono/ws';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { resolveLiveSessionUser, resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { MFA_REQUIRED_CHANNEL_PREFIX } from '@/modules/auth/mfa-events.js';
import {
  DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import { hasAnyDockerNodeRouteAccess, hasDockerNodeRouteAccess } from '@/modules/docker/docker-route-resolvers.js';
import {
  INFERENCE_USAGE_CHANGED_CHANNEL,
  type InferenceUsageChangedEvent,
} from '@/modules/inference/accounting/inference-usage-events.js';
import { INFERENCE_SETUP_EVENT_CHANNEL } from '@/modules/inference/inference-setup-events.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';

const logger = createChildLogger('Events-WebSocket');

interface ConnState {
  user: User | null;
  scopes: string[];
  authenticated: boolean;
  /** channel → unsubscribe fn from EventBus */
  subs: Map<string, () => void>;
  keepalive: ReturnType<typeof setInterval> | null;
  /** unsubscribe from this user's permissions.changed.<userId> */
  permsUnsub: (() => void) | null;
  /** Messages received before authentication completes — drained on auth. */
  pendingMessages: ClientMsg[];
}

interface ClientMsg {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  channels?: string[];
}

type ServerMsg =
  | { type: 'event'; channel: string; payload: unknown }
  | { type: 'subscribed'; channels: string[]; rejected: string[] }
  | { type: 'permissions'; scopes: string[] }
  | { type: 'pong' }
  | { type: 'error'; message: string };

const states = new WeakMap<WSContext, ConnState>();
const DATABASE_CHANNEL_SCOPE_BASES = [
  'databases:view',
  'databases:edit',
  'databases:query:read',
  'databases:query:write',
  'databases:query:admin',
] as const;

function send(ws: WSContext, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

/**
 * Determine the scope required to subscribe to a channel.
 * Channels without an explicit mapping are denied by default.
 */
function requiredScopeFor(channel: string): string | null {
  if (channel.startsWith('permissions.changed.')) return null;
  if (channel.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) return null;
  if (channel === 'read-model.refreshed') return null;
  if (channel === 'domain.changed') return 'domains:view';
  if (channel === 'logging.logs.ingested') return 'logs:read';
  if (channel === 'logging.health.changed') return 'housekeeping:view';
  if (channel === 'logging.environment.changed') return 'logs:environments:view';
  if (channel === 'logging.schema.changed') return 'logs:schemas:view';
  if (channel === 'system.update.changed') return 'admin:update';
  if (channel === 'system.config.changed') return null;
  if (channel === 'status-page.changed') return 'status-page:view';
  if (channel === 'pki.template.changed') return 'pki:templates:view';
  if (channel === 'nginx.template.changed') return 'proxy:templates:view';
  if (channel === 'docker.folder.changed') return 'docker:containers:view';
  if (channel === 'docker.image-cleanup.changed') return 'docker:containers:edit';
  if (channel === 'docker.registry.changed') return 'docker:registries:view';
  if (channel === 'docker.file.changed') return 'docker:containers:files';
  if (channel === 'docker.volume.file.changed') return 'docker:volumes:files:read';
  if (channel === 'docker.snapshot.changed') return 'docker:containers:view';
  if (channel === 'docker.migration.changed') return 'docker:containers:view';
  if (channel === 'node.file.changed') return 'nodes:files:read';
  if (channel.startsWith('docker.container')) return 'docker:containers:view';
  if (channel.startsWith('docker.image')) return 'docker:images:view';
  if (channel.startsWith('docker.volume')) return 'docker:volumes:view';
  if (channel.startsWith('docker.network')) return 'docker:networks:view';
  if (channel.startsWith('docker.registry')) return 'docker:registries:view';
  if (channel.startsWith('docker.task')) return 'docker:tasks';
  if (channel.startsWith('docker.webhook')) return 'docker:containers:webhooks';
  if (channel.startsWith('docker.')) return 'docker:containers:view';
  if (channel === 'database.folder.changed') return 'databases:view';
  if (channel.startsWith('database.')) return 'databases:view';
  if (channel.startsWith('proxy.host')) return 'proxy:view';
  if (channel.startsWith('ssl.cert')) return 'ssl:cert:view';
  if (channel === 'cert.changed') return 'pki:cert:view';
  if (channel === 'ca.changed') return 'pki:ca:view:root';
  if (channel === 'access-list.changed') return 'acl:view';
  if (channel === 'node.slug.changed') return 'nodes:details';
  if (channel === 'node.changed' || channel === 'node.folder.changed') return 'nodes:details';
  if (channel === 'user.changed') return 'admin:users';
  if (channel === 'audit.changed') return 'admin:audit';
  if (channel === 'siem.destination.changed' || channel === 'siem.delivery.changed') return 'audit:siem:view';
  if (channel === 'group.changed') return 'admin:groups';
  if (channel === 'notification.alert-rule.changed') return 'notifications:view';
  if (channel === 'notification.webhook.changed') return 'notifications:view';
  if (channel === INFERENCE_SETUP_EVENT_CHANNEL) return 'inference:use';
  if (channel === 'integration.connector.changed') return 'integrations:gitlab:view';
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) return 'inference:usage:view:self';
  if (channel.startsWith('alert.')) return 'notifications:view';
  // permissions.changed.<userId> is filtered separately (own user only)
  return null;
}

function hasChannelAccess(scopes: string[], channel: string): boolean {
  if (channel.startsWith('permissions.changed.')) return true;
  if (channel.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) return true;
  if (channel === 'read-model.refreshed') return true;
  if (channel === 'system.update.changed') return true;
  if (channel === 'system.config.changed') return true;
  if (channel === 'system.relay.health.changed') return true;
  if (channel === 'integration.connector.changed') {
    return (
      hasScope(scopes, 'integrations:gitlab:view') ||
      hasScope(scopes, 'integrations:gitlab:manage') ||
      hasScope(scopes, 'integrations:cloudflare:view') ||
      hasScope(scopes, 'integrations:cloudflare:manage') ||
      hasScope(scopes, 'integrations:cloudflare:dns:view') ||
      hasScope(scopes, 'integrations:cloudflare:dns:edit') ||
      hasScope(scopes, 'integrations:cloudflare:dns:delete')
    );
  }
  const required = requiredScopeFor(channel);
  if (!required) return false;

  if (channel === 'docker.folder.changed') {
    return (
      hasScopeBase(scopes, 'docker:containers:view') ||
      hasScopeBase(scopes, 'docker:images:view') ||
      hasScopeBase(scopes, 'docker:volumes:view') ||
      hasScopeBase(scopes, 'docker:networks:view') ||
      hasScope(scopes, 'docker:containers:folders:manage')
    );
  }
  if (channel === 'docker.snapshot.changed') {
    return (
      hasScopeBase(scopes, 'docker:containers:view') ||
      hasScopeBase(scopes, 'docker:images:view') ||
      hasScopeBase(scopes, 'docker:volumes:view') ||
      hasScopeBase(scopes, 'docker:networks:view')
    );
  }
  if (channel.startsWith('docker.task')) {
    return hasScope(scopes, 'docker:tasks');
  }
  if (channel === 'docker.migration.changed') {
    return hasScopeBase(scopes, 'docker:containers:view');
  }
  if (channel.startsWith('docker.container')) {
    return hasScopeBase(scopes, 'docker:containers:view');
  }
  if (channel === 'docker.file.changed') {
    return hasScopeBase(scopes, 'docker:containers:files');
  }
  if (channel === 'docker.image-cleanup.changed') {
    return hasScopeBase(scopes, 'docker:containers:edit');
  }
  if (channel.startsWith('docker.image')) {
    return hasScopeBase(scopes, 'docker:images:view');
  }
  if (channel.startsWith('docker.volume')) {
    return hasScopeBase(scopes, 'docker:volumes:view');
  }
  if (channel.startsWith('docker.network')) {
    return hasScopeBase(scopes, 'docker:networks:view');
  }
  if (channel === 'database.folder.changed') {
    return hasScopeBase(scopes, 'databases:view') || hasScope(scopes, 'databases:folders:manage');
  }
  if (channel.startsWith('database.')) {
    return scopes.some((scope) =>
      DATABASE_CHANNEL_SCOPE_BASES.some((base) => scope === base || scope.startsWith(`${base}:`))
    );
  }
  if (channel === 'domain.changed') {
    return hasScopeBase(scopes, 'domains:view') || hasScope(scopes, 'domains:folders:manage');
  }
  if (channel.startsWith('proxy.host')) {
    return hasScopeBase(scopes, 'proxy:view') || hasScope(scopes, 'proxy:folders:manage');
  }
  if (channel === 'node.folder.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasScope(scopes, 'nodes:folders:manage');
  }
  if (channel === 'node.file.changed') {
    return hasScopeBase(scopes, 'nodes:files:read');
  }
  if (channel === 'node.slug.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasAnyDockerNodeRouteAccess(scopes);
  }
  if (channel === 'node.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasAnyDockerNodeRouteAccess(scopes);
  }
  if (channel === 'notification.alert-rule.changed') {
    return (
      hasScope(scopes, 'notifications:alerts:view') ||
      hasScope(scopes, 'notifications:view') ||
      hasScope(scopes, 'notifications:manage')
    );
  }
  if (channel === 'notification.webhook.changed') {
    return (
      hasScope(scopes, 'notifications:webhooks:view') ||
      hasScope(scopes, 'notifications:view') ||
      hasScope(scopes, 'notifications:manage')
    );
  }
  if (channel === INFERENCE_SETUP_EVENT_CHANNEL) {
    return (
      hasScope(scopes, 'inference:use') ||
      hasScope(scopes, 'inference:providers:view') ||
      hasScope(scopes, 'inference:models:manage') ||
      hasScope(scopes, 'inference:limits:manage') ||
      hasScope(scopes, 'feat:ai:configure')
    );
  }
  if (channel === 'logging.logs.ingested') {
    return hasScopeBase(scopes, 'logs:read');
  }
  if (channel === 'logging.environment.changed') {
    return hasScopeBase(scopes, 'logs:environments:view') || hasScope(scopes, 'logs:environments:folders:manage');
  }
  if (channel === 'logging.schema.changed') {
    return hasScopeBase(scopes, 'logs:schemas:view') || hasScope(scopes, 'logs:schemas:folders:manage');
  }
  if (channel === 'user.changed') {
    return hasScopeBase(scopes, 'admin:users') || hasScope(scopes, 'admin:users:folders:manage');
  }
  if (channel === 'group.changed') {
    return hasScopeBase(scopes, 'admin:groups') || hasScope(scopes, 'admin:groups:folders:manage');
  }
  if (channel === 'ca.changed') {
    return hasScope(scopes, 'pki:ca:view:root') || hasScope(scopes, 'pki:ca:view:intermediate');
  }

  return hasScopeBase(scopes, required);
}

function isProxyFolderLayoutPayload(payload: unknown): boolean {
  const action = (payload as { action?: string } | undefined)?.action;
  return (
    action === 'folders_reordered' ||
    action === 'hosts_moved' ||
    action === 'hosts_reordered' ||
    !!action?.startsWith('folder_')
  );
}

function dockerEventResourceId(payload: unknown): string | null {
  const event = payload as
    | {
        nodeId?: string;
        scopeResourceId?: string;
        deploymentId?: string;
        containerId?: string;
        id?: string;
        containerName?: string;
        name?: string;
      }
    | undefined;
  if (event?.scopeResourceId) return event.scopeResourceId;
  if (event?.deploymentId) return event.deploymentId;
  if (!event?.nodeId) return null;
  try {
    return container.resolve(DockerAccessResourceService).cachedContainerResourceId(event.nodeId, {
      runtimeId: event.containerId ?? event.id,
      name: event.containerName ?? event.name,
    });
  } catch {
    return null;
  }
}

function hasDockerEventAccess(scopes: string[], baseScope: string, payload: unknown): boolean {
  const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
  if (!nodeId) return false;
  return hasDockerResourceScope(scopes, baseScope, nodeId, dockerEventResourceId(payload) ?? '');
}

function canReceiveChannelPayload(scopes: string[], channel: string, payload: unknown, userId?: string): boolean {
  if (channel === 'system.update.changed') return true;
  if (channel === 'system.config.changed') return true;
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) {
    const event = payload as Partial<InferenceUsageChangedEvent> | undefined;
    return event?.targetUserId === null || event?.targetUserId === userId;
  }
  if (channel === INFERENCE_SETUP_EVENT_CHANNEL) return hasChannelAccess(scopes, channel);
  if (channel === 'docker.snapshot.changed') {
    const event = payload as { nodeId?: string; kind?: string } | undefined;
    if (!event?.nodeId || !event.kind) return false;
    const scope =
      event.kind === 'containers' || event.kind === 'container-detail'
        ? 'docker:containers:view'
        : event.kind === 'images'
          ? 'docker:images:view'
          : event.kind === 'volumes' || event.kind === 'volume-detail'
            ? 'docker:volumes:view'
            : event.kind === 'networks'
              ? 'docker:networks:view'
              : null;
    if (!scope) return false;
    if (hasScope(scopes, scope) || hasScope(scopes, `${scope}:${event.nodeId}`)) return true;
    return (
      scope === 'docker:containers:view' &&
      dockerScopedNodeIds(scopes, ['docker:containers:view']).includes(event.nodeId)
    );
  }
  if (channel === 'docker.folder.changed') {
    if (
      hasScope(scopes, 'docker:containers:view') ||
      hasScope(scopes, 'docker:images:view') ||
      hasScope(scopes, 'docker:volumes:view') ||
      hasScope(scopes, 'docker:networks:view') ||
      hasScope(scopes, 'docker:containers:folders:manage')
    ) {
      return true;
    }
    const nodeIds = (payload as { nodeIds?: string[] } | undefined)?.nodeIds;
    const childScopedNodeIds = new Set(dockerScopedNodeIds(scopes, ['docker:containers:view']));
    return (
      Array.isArray(nodeIds) &&
      nodeIds.some(
        (nodeId) =>
          hasScope(scopes, `docker:containers:view:${nodeId}`) ||
          hasScope(scopes, `docker:images:view:${nodeId}`) ||
          hasScope(scopes, `docker:volumes:view:${nodeId}`) ||
          hasScope(scopes, `docker:networks:view:${nodeId}`) ||
          childScopedNodeIds.has(nodeId)
      )
    );
  }
  if (channel.startsWith('docker.webhook')) {
    return hasDockerEventAccess(scopes, 'docker:containers:webhooks', payload);
  }
  if (channel.startsWith('docker.deployment') || channel.startsWith('docker.health')) {
    return hasDockerEventAccess(scopes, 'docker:containers:view', payload);
  }
  if (channel.startsWith('docker.task')) {
    return hasScope(scopes, 'docker:tasks');
  }
  if (channel === 'docker.migration.changed') {
    const event = payload as { sourceNodeId?: string; targetNodeId?: string; scopeResourceId?: string } | undefined;
    if (!event?.sourceNodeId || !event.targetNodeId || !event.scopeResourceId) return false;
    return [event.sourceNodeId, event.targetNodeId].some((nodeId) =>
      hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, event.scopeResourceId!)
    );
  }
  if (channel.startsWith('docker.container')) {
    return hasDockerEventAccess(scopes, 'docker:containers:view', payload);
  }
  if (channel === 'docker.file.changed') {
    return hasDockerEventAccess(scopes, 'docker:containers:files', payload);
  }
  if (channel === 'docker.volume.file.changed') {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return (
      hasScope(scopes, 'docker:volumes:files:read') ||
      !!(nodeId && hasScope(scopes, `docker:volumes:files:read:${nodeId}`))
    );
  }
  if (channel === 'node.file.changed') {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return hasScope(scopes, 'nodes:files:read') || !!(nodeId && hasScope(scopes, `nodes:files:read:${nodeId}`));
  }
  if (channel === 'docker.image-cleanup.changed') {
    return hasDockerEventAccess(scopes, 'docker:containers:edit', payload);
  }
  if (channel.startsWith('docker.image')) {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return hasScope(scopes, 'docker:images:view') || !!(nodeId && hasScope(scopes, `docker:images:view:${nodeId}`));
  }
  if (channel.startsWith('docker.volume')) {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return hasScope(scopes, 'docker:volumes:view') || !!(nodeId && hasScope(scopes, `docker:volumes:view:${nodeId}`));
  }
  if (channel.startsWith('docker.network')) {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return hasScope(scopes, 'docker:networks:view') || !!(nodeId && hasScope(scopes, `docker:networks:view:${nodeId}`));
  }
  if (channel === 'database.folder.changed') {
    return hasScopeBase(scopes, 'databases:view') || hasScope(scopes, 'databases:folders:manage');
  }
  if (channel.startsWith('database.')) {
    const databaseId = (payload as { id?: string } | undefined)?.id;
    return (
      DATABASE_CHANNEL_SCOPE_BASES.some((base) => hasScope(scopes, base)) ||
      !!(databaseId && DATABASE_CHANNEL_SCOPE_BASES.some((base) => hasScope(scopes, `${base}:${databaseId}`)))
    );
  }
  if (channel === 'logging.logs.ingested') {
    const environmentId = (payload as { environmentId?: string } | undefined)?.environmentId;
    return hasScope(scopes, 'logs:read') || !!(environmentId && hasScope(scopes, `logs:read:${environmentId}`));
  }
  if (channel === 'logging.environment.changed') {
    const environmentId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'logs:environments:view') ||
      !!(environmentId && hasScope(scopes, `logs:environments:view:${environmentId}`)) ||
      (!environmentId && hasScope(scopes, 'logs:environments:folders:manage'))
    );
  }
  if (channel === 'logging.schema.changed') {
    const schemaId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'logs:schemas:view') ||
      !!(schemaId && hasScope(scopes, `logs:schemas:view:${schemaId}`)) ||
      (!schemaId && hasScope(scopes, 'logs:schemas:folders:manage'))
    );
  }
  if (channel.startsWith('proxy.host')) {
    const hostId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'proxy:view') ||
      !!(hostId && hasScope(scopes, `proxy:view:${hostId}`)) ||
      (hasScopeBase(scopes, 'proxy:view') && !hostId && isProxyFolderLayoutPayload(payload)) ||
      (hasScope(scopes, 'proxy:folders:manage') && !hostId && isProxyFolderLayoutPayload(payload))
    );
  }
  if (channel.startsWith('ssl.cert')) {
    const certId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'ssl:cert:view') || !!(certId && hasScope(scopes, `ssl:cert:view:${certId}`));
  }
  if (channel === 'cert.changed') {
    const certId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'pki:cert:view') || !!(certId && hasScope(scopes, `pki:cert:view:${certId}`));
  }
  if (channel === 'ca.changed') {
    const caType = (payload as { type?: string } | undefined)?.type;
    if (caType === 'root') return hasScope(scopes, 'pki:ca:view:root');
    if (caType === 'intermediate') return hasScope(scopes, 'pki:ca:view:intermediate');
    return hasScope(scopes, 'pki:ca:view:root') || hasScope(scopes, 'pki:ca:view:intermediate');
  }
  if (channel === 'access-list.changed') {
    const aclId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'acl:view') || !!(aclId && hasScope(scopes, `acl:view:${aclId}`));
  }
  if (channel === 'node.slug.changed') {
    const nodeId = (payload as { id?: string } | undefined)?.id;
    return !!nodeId && (hasScope(scopes, `nodes:details:${nodeId}`) || hasDockerNodeRouteAccess(scopes, nodeId));
  }
  if (channel === 'node.changed') {
    const nodeId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'nodes:details') ||
      !!(nodeId && (hasScope(scopes, `nodes:details:${nodeId}`) || hasDockerNodeRouteAccess(scopes, nodeId)))
    );
  }
  if (channel === 'node.folder.changed') {
    return hasScope(scopes, 'nodes:details') || hasScope(scopes, 'nodes:folders:manage');
  }
  if (channel === 'user.changed') {
    const userId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'admin:users') ||
      !!(userId && hasScope(scopes, `admin:users:${userId}`)) ||
      (!userId && hasScope(scopes, 'admin:users:folders:manage'))
    );
  }
  if (channel === 'group.changed') {
    const groupId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'admin:groups') ||
      !!(groupId && hasScope(scopes, `admin:groups:${groupId}`)) ||
      (!groupId && hasScope(scopes, 'admin:groups:folders:manage'))
    );
  }
  if (channel === 'nginx.template.changed') {
    const templateId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'proxy:templates:view') ||
      !!(templateId && hasScope(scopes, `proxy:templates:view:${templateId}`))
    );
  }
  return true;
}

async function authenticate(token: string): Promise<{ user: User; scopes: string[] } | null> {
  const result = await resolveLiveSessionUser(token);
  if (result?.user.isBlocked) return null;
  return result ? { user: result.user, scopes: result.effectiveScopes } : null;
}

function closeUnauthenticated(ws: WSContext, state: ConnState, message = 'unauthenticated') {
  send(ws, { type: 'error', message });
  clearAll(state);
  try {
    ws.close(4001, message);
  } catch {
    /* ignore */
  }
}

function clearAll(state: ConnState) {
  for (const unsub of state.subs.values()) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  state.subs.clear();
  if (state.permsUnsub) {
    try {
      state.permsUnsub();
    } catch {
      /* ignore */
    }
    state.permsUnsub = null;
  }
  if (state.keepalive) {
    clearInterval(state.keepalive);
    state.keepalive = null;
  }
}

function subscribePerUser(ws: WSContext, state: ConnState) {
  if (!state.user) return;
  const eventBus = container.resolve(EventBusService);
  const channel = `permissions.changed.${state.user.id}`;
  // Side-effect listener: refresh server-side scopes and drop subscriptions
  // the user has lost access to. The actual delivery to the client goes
  // through the client's explicit subscribe path so we don't double-emit.
  state.permsUnsub = eventBus.subscribe(channel, async (_payload) => {
    try {
      const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
      const fresh = await resolveLiveUser(db, state.user!.id);
      if (!fresh || fresh.isBlocked) {
        closeUnauthenticated(ws, state);
        return;
      }
      if (fresh) {
        state.user = fresh;
        state.scopes = fresh.scopes ?? [];
      }
    } catch {
      /* ignore */
    }
    for (const ch of [...state.subs.keys()]) {
      const required = requiredScopeFor(ch);
      if (required && !hasChannelAccess(state.scopes, ch)) {
        const unsub = state.subs.get(ch);
        unsub?.();
        state.subs.delete(ch);
      }
    }
    send(ws, { type: 'permissions', scopes: state.scopes });
  });
}

export function createEventsWSHandlers() {
  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ConnState = {
        user: null,
        scopes: [],
        authenticated: false,
        subs: new Map(),
        keepalive: null,
        permsUnsub: null,
        pendingMessages: [],
      };
      states.set(ws, state);
      state.keepalive = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          if (state.keepalive) clearInterval(state.keepalive);
        }
      }, 30_000);
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = states.get(ws);
      if (!state) return;

      let msg: ClientMsg;
      try {
        const raw = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
          send(ws, { type: 'error', message: 'invalid message' });
          return;
        }
        msg = raw as ClientMsg;
      } catch {
        send(ws, { type: 'error', message: 'invalid json' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      // Queue messages until authentication completes (auth is async).
      if (!state.authenticated) {
        state.pendingMessages.push(msg);
        return;
      }

      processMessage(ws, state, msg);
    },

    onClose(_event: Event, ws: WSContext) {
      const state = states.get(ws);
      if (state) {
        clearAll(state);
      }
    },

    onError(_event: Event, ws: WSContext) {
      const state = states.get(ws);
      if (state) {
        clearAll(state);
      }
    },
  };
}

function processMessage(ws: WSContext, state: ConnState, msg: ClientMsg) {
  const eventBus = container.resolve(EventBusService);

  if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
    const accepted: string[] = [];
    const rejected: string[] = [];
    const retained: Array<{ channel: string; payload: unknown }> = [];
    for (const ch of msg.channels) {
      if (typeof ch !== 'string' || !ch) continue;
      if (state.subs.has(ch)) {
        accepted.push(ch);
        continue;
      }
      if (!hasChannelAccess(state.scopes, ch)) {
        rejected.push(ch);
        continue;
      }
      // permissions.changed.<userId>: only the user's own is allowed
      if (ch.startsWith('permissions.changed.')) {
        const targetUserId = ch.slice('permissions.changed.'.length);
        if (targetUserId !== state.user?.id) {
          rejected.push(ch);
          continue;
        }
      }
      if (ch.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) {
        const targetUserId = ch.slice(MFA_REQUIRED_CHANNEL_PREFIX.length);
        if (targetUserId !== state.user?.id) {
          rejected.push(ch);
          continue;
        }
      }
      const unsub = eventBus.subscribe(ch, (payload) => {
        if (!canReceiveChannelPayload(state.scopes, ch, payload, state.user?.id)) return;
        send(ws, { type: 'event', channel: ch, payload });
      });
      state.subs.set(ch, unsub);
      accepted.push(ch);
      const retainedPayload = eventBus.getRetained(ch);
      if (retainedPayload !== undefined) retained.push({ channel: ch, payload: retainedPayload });
    }
    send(ws, { type: 'subscribed', channels: accepted, rejected });
    for (const event of retained) {
      if (canReceiveChannelPayload(state.scopes, event.channel, event.payload, state.user?.id)) {
        send(ws, { type: 'event', channel: event.channel, payload: event.payload });
      }
    }
    return;
  }

  if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
    for (const ch of msg.channels) {
      const unsub = state.subs.get(ch);
      if (unsub) {
        unsub();
        state.subs.delete(ch);
      }
    }
  }
}

/**
 * Authenticate after onOpen — same pattern as the AI WS endpoint.
 */
export async function authenticateEventsConnection(ws: WSContext, token: string): Promise<void> {
  const state = states.get(ws);
  if (!state) return;
  const authResult = await authenticate(token);
  if (!authResult) {
    closeUnauthenticated(ws, state);
    return;
  }
  state.user = authResult.user;
  state.scopes = authResult.scopes;
  state.authenticated = true;
  subscribePerUser(ws, state);
  send(ws, { type: 'permissions', scopes: state.scopes });
  logger.debug('client authenticated', { userId: state.user.id });
  // Drain anything the client sent before auth completed
  const pending = state.pendingMessages.splice(0);
  for (const msg of pending) {
    processMessage(ws, state, msg);
  }
}
