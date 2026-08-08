import { describe, expect, it } from 'vitest';
import { __testOnly } from './audit-context.js';

describe('sanitizeAuditPath', () => {
  it('redacts high-entropy path segments', () => {
    expect(__testOnly.sanitizeAuditPath('/api/webhooks/docker/0123456789abcdef0123456789abcdef')).toBe(
      '/api/webhooks/docker/:redacted'
    );
  });

  it('redacts uuid segments and keeps stable route parts', () => {
    expect(__testOnly.sanitizeAuditPath('/api/nodes/123e4567-e89b-12d3-a456-426614174000/config')).toBe(
      '/api/nodes/:id/config'
    );
  });
});

describe('resolveFallbackAuditTarget', () => {
  it('maps Docker container actions away from generic route audit actions', () => {
    expect(
      __testOnly.resolveFallbackAuditTarget(
        'POST',
        '/api/docker/nodes/11111111-1111-4111-8111-111111111111/containers/f4b0d9c82b26/start'
      )
    ).toEqual({
      action: 'docker.container.start',
      resourceType: 'docker-container',
      resourceId: 'f4b0d9c82b26',
    });
  });

  it('maps Docker health-check routes that do not emit service audit entries', () => {
    expect(
      __testOnly.resolveFallbackAuditTarget(
        'PUT',
        '/api/docker/nodes/11111111-1111-4111-8111-111111111111/containers/api/health-check'
      )
    ).toEqual({
      action: 'docker.health_check.configure',
      resourceType: 'docker-health-check',
      resourceId: 'api',
    });
  });

  it('maps system update routes away from generic route audit actions', () => {
    expect(
      __testOnly.resolveFallbackAuditTarget('POST', '/api/system/daemon-updates/11111111-1111-4111-8111-111111111111')
    ).toEqual({
      action: 'system.daemon_update.perform',
      resourceType: 'daemon-update',
      resourceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('maps AI routes away from generic route audit actions', () => {
    expect(__testOnly.resolveFallbackAuditTarget('PUT', '/api/ai/config')).toEqual({
      action: 'ai.config.update',
      resourceType: 'ai-config',
      resourceId: undefined,
    });
    expect(__testOnly.resolveFallbackAuditTarget('DELETE', '/api/ai/conversations/chat-1')).toEqual({
      action: 'ai.conversation.delete',
      resourceType: 'ai-conversation',
      resourceId: 'chat-1',
    });
  });

  it('keeps a generic fallback for unknown mutating routes', () => {
    expect(__testOnly.resolveFallbackAuditTarget('POST', '/api/unknown')).toEqual({
      action: 'route.post',
      resourceType: 'http-route',
    });
  });
});

describe('shouldSkipFallbackAudit', () => {
  it('skips high-volume logging ingest and read-style POST routes', () => {
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/logging/ingest')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/logging/ingest/batch')).toBe(true);
    expect(
      __testOnly.shouldSkipFallbackAudit(
        'POST',
        '/api/logging/environments/11111111-1111-4111-8111-111111111111/search'
      )
    ).toBe(true);
  });

  it('skips MCP protocol traffic and non-auditable background-style requests', () => {
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/mcp')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/mcp/')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/ai/context-estimate')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/monitoring/dashboard/bootstrap')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/docker/snapshots/refresh')).toBe(true);
  });

  it('skips successful checks, previews, validations, and refresh-only requests', () => {
    const paths = [
      '/api/system/check-update',
      '/api/system/daemon-updates/check',
      '/api/system/license/check',
      '/api/domains/preview',
      '/api/domains/domain-1/check-dns',
      '/api/proxy-hosts/validate-config',
      '/api/nginx-templates/preview',
      '/api/nginx-templates/test',
      '/api/nodes/node-1/config/test',
      '/api/integrations/gitlab/allowlist/preview-search',
      '/api/integrations/gitlab/connectors/preview-test',
      '/api/integrations/cloudflare/connectors/preview-test',
      '/api/integrations/gitlab/connectors/connector-1/allowlist/options/refresh',
      '/api/notifications/webhooks/preview',
      '/api/audit/siem/destinations/11111111-1111-4111-8111-111111111111/test',
      '/api/docker/nodes/node-1/containers/app/health-check/test',
      '/api/docker/nodes/node-1/deployments/app/health-check/test',
    ];

    for (const path of paths) {
      expect(__testOnly.shouldSkipFallbackAudit('POST', path), path).toBe(true);
    }
  });

  it('skips Docker folder read and ordering routes that only affect list layout', () => {
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/docker/folders/placements')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('PUT', '/api/docker/folders/reorder')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('PUT', '/api/docker/folders/reorder-containers')).toBe(true);
    expect(__testOnly.shouldSkipFallbackAudit('PUT', '/api/docker/folders/reorder-resources')).toBe(true);
  });

  it('keeps Docker folder create and delete routes eligible for service or fallback audit', () => {
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/docker/folders')).toBe(false);
    expect(__testOnly.shouldSkipFallbackAudit('DELETE', '/api/docker/folders/folder-1')).toBe(false);
  });

  it('keeps logging create/update/delete routes eligible for service or fallback audit', () => {
    expect(__testOnly.shouldSkipFallbackAudit('POST', '/api/logging/environments')).toBe(false);
    expect(
      __testOnly.shouldSkipFallbackAudit('DELETE', '/api/logging/environments/11111111-1111-4111-8111-111111111111')
    ).toBe(false);
  });
});
