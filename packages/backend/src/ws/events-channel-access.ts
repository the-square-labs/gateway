import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { TOOL_STORE_INVALIDATION_CHANNEL_PREFIX } from '@/modules/ai/ai-tool-store-invalidation.js';
import { MFA_REQUIRED_CHANNEL_PREFIX } from '@/modules/auth/mfa-events.js';
import { userResourceChannelUserId } from '@/modules/auth/user-resource-events.js';
import { hasAnyDockerNodeRouteAccess } from '@/modules/docker/docker-route-resolvers.js';
import { INFERENCE_USAGE_CHANGED_CHANNEL } from '@/modules/inference/accounting/inference-usage-events.js';
import { INFERENCE_SETUP_EVENT_CHANNEL } from '@/modules/inference/inference-setup-events.service.js';

export const DATABASE_CHANNEL_SCOPE_BASES = [
  'databases:view',
  'databases:edit',
  'databases:query:read',
  'databases:query:write',
  'databases:query:admin',
] as const;

/**
 * Determine the scope required to subscribe to a channel.
 * Channels without an explicit mapping are denied by default.
 */
export function requiredScopeFor(channel: string): string | null {
  if (channel.startsWith('permissions.changed.')) return null;
  if (channel.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) return null;
  if (channel.startsWith(TOOL_STORE_INVALIDATION_CHANNEL_PREFIX)) return null;
  if (userResourceChannelUserId(channel)) return null;
  if (channel === 'read-model.refreshed') return null;
  if (channel === 'domain.changed') return 'domains:view';
  if (channel === 'logging.logs.ingested') return 'logs:read';
  if (channel === 'logging.health.changed') return 'housekeeping:view';
  if (channel === 'logging.environment.changed') return 'logs:environments:view';
  if (channel === 'logging.schema.changed') return 'logs:schemas:view';
  if (channel === 'logging.token.changed') return 'logs:tokens:view';
  if (channel === 'system.update.changed') return 'admin:update';
  if (channel === 'inference.core.changed') return 'inference:providers:view';
  if (channel === 'system.license.changed') return null;
  if (channel === 'system.config.changed') return null;
  if (channel === 'status-page.changed') return 'status-page:view';
  if (channel === 'pki.template.changed') return 'pki:templates:view';
  if (channel === 'nginx.template.changed') return 'proxy:templates:view';
  if (channel === 'docker.folder.changed') return 'docker:containers:view';
  if (channel === 'docker.image-cleanup.changed') return 'docker:containers:edit';
  if (channel === 'docker.registry.changed') return 'docker:registries:view';
  if (channel.startsWith('docker.build')) return 'docker:containers:view';
  if (channel === 'docker.file.changed') return 'docker:containers:files:read';
  if (channel === 'docker.volume.file.changed') return 'docker:volumes:files:read';
  if (channel === 'docker.snapshot.changed') return 'docker:containers:view';
  if (channel === 'docker.migration.changed') return 'docker:containers:view';
  if (channel === 'docker.runtime.changed') return 'nodes:details';
  if (channel.startsWith('docker.compose')) return 'docker:compose:view';
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
  if (channel === 'pages.profile.changed') return 'pages:settings:view';
  if (channel === 'pages.folder.changed') return 'pages:view';
  if (channel.startsWith('pages.')) return 'pages:view';
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
  if (channel === INFERENCE_SETUP_EVENT_CHANNEL) return 'feat:ai:use';
  if (channel === 'integration.connector.changed') return 'integrations:gitlab:view';
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) return 'feat:ai:use';
  if (channel.startsWith('alert.')) return 'notifications:view';
  // permissions.changed.<userId> is filtered separately (own user only)
  return null;
}

export function hasChannelAccess(scopes: string[], channel: string): boolean {
  if (channel.startsWith('permissions.changed.')) return true;
  if (channel.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) return true;
  if (channel.startsWith(TOOL_STORE_INVALIDATION_CHANNEL_PREFIX)) return true;
  if (userResourceChannelUserId(channel)) return true;
  if (channel === 'read-model.refreshed') return true;
  if (channel === 'system.update.changed') return true;
  if (channel === 'system.license.changed') return true;
  if (channel === 'system.config.changed') return true;
  if (channel === 'system.relay.health.changed') return true;
  if (channel === 'integration.connector.changed') {
    return (
      hasScope(scopes, 'integrations:gitlab:view') ||
      hasScope(scopes, 'integrations:gitlab:manage') ||
      hasScope(scopes, 'integrations:cloudflare:view') ||
      hasScope(scopes, 'integrations:cloudflare:manage') ||
      hasScope(scopes, 'integrations:github:view') ||
      hasScope(scopes, 'integrations:github:manage') ||
      hasScope(scopes, 'integrations:git:view') ||
      hasScope(scopes, 'integrations:git:manage') ||
      hasScope(scopes, 'integrations:ssh:view') ||
      hasScope(scopes, 'integrations:ssh:manage')
    );
  }
  if (channel.startsWith('docker.build')) {
    return hasScopeBase(scopes, 'docker:containers:view') || hasScopeBase(scopes, 'docker:compose:view');
  }
  const required = requiredScopeFor(channel);
  if (!required) return false;

  if (channel === 'docker.folder.changed') {
    return (
      hasScopeBase(scopes, 'docker:containers:view') ||
      hasScopeBase(scopes, 'docker:images:view') ||
      hasScopeBase(scopes, 'docker:volumes:view') ||
      hasScopeBase(scopes, 'docker:networks:view') ||
      hasScopeBase(scopes, 'docker:compose:view') ||
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
  if (channel === 'docker.runtime.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasAnyDockerNodeRouteAccess(scopes);
  }
  if (channel.startsWith('docker.container')) {
    return hasScopeBase(scopes, 'docker:containers:view');
  }
  if (channel === 'docker.file.changed') {
    return hasScopeBase(scopes, 'docker:containers:files:read');
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
  if (channel === 'pages.profile.changed') {
    return hasScope(scopes, 'pages:settings:view');
  }
  if (channel === 'pages.folder.changed') {
    return hasScopeBase(scopes, 'pages:view') || hasScope(scopes, 'pages:folders:manage');
  }
  if (channel.startsWith('pages.')) {
    return hasScopeBase(scopes, 'pages:view');
  }
  if (channel === 'domain.changed') {
    return hasScopeBase(scopes, 'domains:view') || hasScope(scopes, 'domains:folders:manage');
  }
  if (channel === 'ssl.cert.folder.changed') {
    return hasScopeBase(scopes, 'ssl:cert:view') || hasScope(scopes, 'ssl:cert:folders:manage');
  }
  if (channel === 'ssl.cert.changed') {
    return hasScopeBase(scopes, 'ssl:cert:view');
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
      hasScope(scopes, 'ai:workspace:use') ||
      hasScope(scopes, 'feat:ai:use') ||
      hasScope(scopes, 'inference:providers:view') ||
      hasScope(scopes, 'inference:models:manage') ||
      hasScope(scopes, 'inference:limits:manage') ||
      hasScope(scopes, 'feat:ai:configure')
    );
  }
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) {
    return (
      hasScope(scopes, 'ai:workspace:use') ||
      hasScope(scopes, 'feat:ai:use') ||
      hasScope(scopes, 'inference:usage:view') ||
      hasScope(scopes, 'inference:limits:manage')
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
  if (channel === 'logging.token.changed') {
    return hasScopeBase(scopes, 'logs:tokens:view');
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
