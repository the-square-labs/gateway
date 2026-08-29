import type { AlertCategory } from './notification-catalog.js';

// ── EventBus → Notification Event Mapping ─────────────────────────────

export interface EventMapping {
  category: AlertCategory;
  eventId: string;
  match: (payload: any) => boolean;
  extractResource: (payload: any) => { type: string; id: string; name?: string };
  extractData?: (payload: any) => Record<string, unknown>;
  stateful?: {
    currentState: (payload: any) => string;
    observedPatterns: string[];
  };
}

export const EVENT_BUS_MAPPINGS: Record<string, EventMapping[]> = {
  'docker.build.changed': [
    ...(['succeeded', 'failed', 'cancelled', 'superseded'] as const).map((status) => ({
      category: 'build' as const,
      eventId: status,
      match: (p: any) => p.status === status,
      extractResource: (p: any) => ({
        type: 'docker_build_source',
        id: p.sourceBindingId,
        name: p.targetName ?? p.sourceBindingId,
      }),
      extractData: (p: any) => ({
        operation_kind: 'build',
        operation_phase: p.status,
        failure_code: p.errorCode ?? null,
        failure_message: p.errorMessage ?? null,
        target_node_id: p.nodeId ?? null,
      }),
    })),
  ],
  'docker.compose.changed': [
    {
      category: 'compose',
      eventId: 'operation.succeeded',
      match: (p) => p.action === 'operation_succeeded',
      extractResource: (p) => ({ type: 'docker_compose_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({ operation_kind: p.operationAction ?? p.action, operation_phase: 'succeeded' }),
    },
    {
      category: 'compose',
      eventId: 'operation.failed',
      match: (p) => p.action === 'operation_failed',
      extractResource: (p) => ({ type: 'docker_compose_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        operation_kind: p.operationAction ?? p.action,
        operation_phase: 'failed',
        failure_code: p.error ?? 'compose_operation_failed',
      }),
    },
    {
      category: 'compose',
      eventId: 'operation.cancelled',
      match: (p) => p.action === 'operation_cancelled',
      extractResource: (p) => ({ type: 'docker_compose_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({ operation_kind: p.operationAction ?? p.action, operation_phase: 'cancelled' }),
    },
    {
      category: 'compose',
      eventId: 'revision.activated',
      match: (p) => p.action === 'revision_activated',
      extractResource: (p) => ({ type: 'docker_compose_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: () => ({ operation_kind: 'revision', operation_phase: 'activated' }),
    },
  ],
  'pages.deployment.changed': [
    {
      category: 'pages',
      eventId: 'deployment.ready',
      match: (p) => p.action === 'ready' || p.status === 'ready',
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        public_slug: p.publicSlug ?? null,
        operation_kind: 'deployment',
        operation_phase: p.status ?? p.action,
      }),
    },
    {
      category: 'pages',
      eventId: 'deployment.failed',
      match: (p) => p.action === 'failed' || p.status === 'failed',
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        public_slug: p.publicSlug ?? null,
        failure_code: p.failureCode ?? 'page_deployment_failed',
        operation_kind: 'deployment',
        operation_phase: p.status ?? p.action,
      }),
    },
  ],
  'pages.tag.changed': [
    {
      category: 'pages',
      eventId: 'publication.failed',
      match: (p) => p.action === 'publication.failed' || p.status === 'failed',
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        tag: p.tag ?? p.name ?? null,
        public_slug: p.publicSlug ?? null,
        failure_code: p.failureCode ?? 'page_publication_failed',
        operation_kind: 'publication',
        operation_phase: p.phase ?? p.status ?? p.action,
      }),
    },
  ],
  'pages.config.changed': [
    {
      category: 'pages',
      eventId: 'config.publication_failed',
      match: (p) => p.action === 'publication.failed',
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        tag_id: p.tagId ?? null,
        generation: p.generation ?? null,
        byte_size: p.byteSize ?? null,
        failure_code: p.failureCode ?? 'pages_runtime_config_publication_failed',
        operation_kind: 'runtime_config',
        operation_phase: p.action,
      }),
    },
  ],
  'pages.project.changed': [
    {
      category: 'pages',
      eventId: 'quota.blocked',
      match: (p) => ['quota.blocked', 'quota.resolved'].includes(p.action),
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        quota_used_bytes: p.quotaUsedBytes ?? null,
        quota_limit_bytes: p.quotaLimitBytes ?? null,
        failure_code: p.failureCode ?? null,
      }),
      stateful: {
        currentState: (p) => (p.action === 'quota.blocked' ? 'quota.blocked' : 'quota.healthy'),
        observedPatterns: ['quota.blocked'],
      },
    },
    {
      category: 'pages',
      eventId: 'cleanup.needs_attention',
      match: (p) => ['cleanup.needs_attention', 'cleanup.healthy'].includes(p.action),
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({ failure_code: p.failureCode ?? null, operation_kind: 'cleanup' }),
      stateful: {
        currentState: (p) => p.action,
        observedPatterns: ['cleanup.needs_attention'],
      },
    },
  ],
  'pages.profile.changed': [
    {
      category: 'pages',
      eventId: 'profile.unavailable',
      match: (p) => typeof p.projectId === 'string' && ['profile.unavailable', 'profile.healthy'].includes(p.action),
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({ failure_code: p.failureCode ?? null, operation_kind: 'profile' }),
      stateful: {
        currentState: (p) => p.action,
        observedPatterns: ['profile.unavailable'],
      },
    },
    {
      category: 'pages',
      eventId: 'capability.missing',
      match: (p) => typeof p.projectId === 'string' && ['capability.missing', 'capability.restored'].includes(p.action),
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        failure_code: p.failureCode ?? null,
        target_node_id: p.nodeId ?? null,
        operation_kind: 'capability',
      }),
      stateful: {
        currentState: (p) => p.action,
        observedPatterns: ['capability.missing'],
      },
    },
  ],
  'pages.migration.changed': [
    {
      category: 'pages',
      eventId: 'migration.failed',
      match: (p) => typeof p.projectId === 'string' && (p.action === 'failed' || p.status === 'failed'),
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        failure_code: p.failureCode ?? 'page_migration_failed',
        operation_kind: 'migration',
        operation_phase: p.phase ?? p.status ?? p.action,
        source_node_id: p.sourceNodeId ?? null,
        target_node_id: p.targetNodeId ?? null,
      }),
    },
    {
      category: 'pages',
      eventId: 'migration.needs_attention',
      match: (p) =>
        typeof p.projectId === 'string' && ['needs_attention', 'healthy', 'complete'].includes(p.status ?? p.action),
      extractResource: (p) => ({ type: 'page_project', id: p.projectId, name: p.projectName ?? p.projectId }),
      extractData: (p) => ({
        failure_code: p.failureCode ?? null,
        operation_kind: 'migration',
        operation_phase: p.phase ?? p.status ?? p.action,
      }),
      stateful: {
        currentState: (p) =>
          (p.status ?? p.action) === 'needs_attention' ? 'migration.needs_attention' : 'migration.healthy',
        observedPatterns: ['migration.needs_attention'],
      },
    },
  ],
  'system.license.changed': [
    {
      category: 'gateway',
      eventId: 'license.unavailable',
      match: () => true,
      extractResource: () => ({ type: 'gateway', id: 'gateway-license', name: 'Gateway license' }),
      extractData: (p) => ({
        plan: p.plan ?? null,
        expires_at: p.expiresAt ?? null,
        grace_until: p.graceUntil ?? p.offlineGraceUntil ?? null,
      }),
      stateful: {
        currentState: (p) => {
          if (p.status === 'expired_grace') return 'license.expired_grace';
          if (p.status === 'valid_with_warning') return 'license.validation_warning';
          if (
            ['expired', 'unreachable_grace_expired', 'invalid', 'revoked', 'replaced', 'deactivated'].includes(p.status)
          ) {
            return 'license.unavailable';
          }
          return 'license.healthy';
        },
        observedPatterns: ['license.expired_grace', 'license.unavailable', 'license.validation_warning'],
      },
    },
  ],
  'system.relay.health.changed': [
    {
      category: 'gateway',
      eventId: 'relay.unavailable',
      match: () => true,
      extractResource: () => ({ type: 'gateway', id: 'gateway-relay', name: 'Gateway relay' }),
      extractData: (p) => ({ failure_code: p.reason ?? null, attempt: p.attempt ?? 0 }),
      stateful: {
        currentState: (p) =>
          p.state === 'critical'
            ? 'relay.unavailable'
            : p.state === 'recovering'
              ? 'relay.recovering'
              : 'relay.healthy',
        observedPatterns: ['relay.recovering', 'relay.unavailable'],
      },
    },
  ],
  'logging.health.changed': [
    {
      category: 'logging',
      eventId: 'storage.unavailable',
      match: () => true,
      extractResource: () => ({ type: 'logging', id: 'logging-storage', name: 'Logging storage' }),
      extractData: (p) => ({ failure_code: typeof p.status === 'string' ? p.status : null }),
      stateful: {
        currentState: (p) =>
          ['pressure', 'degraded', 'exhausted', 'unavailable'].includes(p.status)
            ? `storage.${p.status}`
            : 'storage.healthy',
        observedPatterns: ['storage.pressure', 'storage.degraded', 'storage.exhausted', 'storage.unavailable'],
      },
    },
  ],
  'integration.connector.changed': [
    {
      category: 'integration',
      eventId: 'sync.failed',
      match: (p) => ['sync-failed', 'synced', 'tested'].includes(p.action),
      extractResource: (p) => ({ type: 'integration_connector', id: p.id, name: p.name ?? p.id }),
      extractData: (p) => ({
        failure_code: p.failureCode ?? null,
        provider: p.provider ?? null,
        failure_count: p.failureCount ?? 0,
      }),
      stateful: {
        currentState: (p) => (p.action === 'sync-failed' ? 'sync.failed' : 'sync.healthy'),
        observedPatterns: ['sync.failed'],
      },
    },
  ],
  'group.mfa.required': [
    {
      category: 'security',
      eventId: 'mfa.required',
      match: (p) => p.requireGateway2fa === true,
      extractResource: (p) => ({ type: 'permission_group', id: p.groupId, name: p.groupName }),
    },
  ],
  'node.changed': [
    {
      category: 'node',
      eventId: 'online',
      match: (p) => p.status === 'online',
      extractResource: (p) => ({ type: 'node', id: p.id, name: p.hostname }),
    },
    {
      category: 'node',
      eventId: 'offline',
      match: (p) => p.status === 'offline',
      extractResource: (p) => ({ type: 'node', id: p.id, name: p.hostname }),
    },
  ],
  'ssl.cert.changed': [
    {
      category: 'certificate',
      eventId: 'issued',
      match: (p) => p.action === 'created',
      extractResource: (p) => ({ type: 'certificate', id: p.id, name: p.name }),
    },
    {
      category: 'certificate',
      eventId: 'renewed',
      match: (p) => p.action === 'renewed',
      extractResource: (p) => ({ type: 'certificate', id: p.id, name: p.name }),
    },
    {
      category: 'certificate',
      eventId: 'renewal_failed',
      match: (p) => p.action === 'renewal_failed',
      extractResource: (p) => ({ type: 'certificate', id: p.id, name: p.name }),
    },
    {
      category: 'certificate',
      eventId: 'expired',
      match: (p) => p.action === 'expired',
      extractResource: (p) => ({ type: 'certificate', id: p.id, name: p.name }),
    },
  ],
  'proxy.host.changed': [
    {
      category: 'proxy',
      eventId: 'created',
      match: (p) => p.action === 'created',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain }),
    },
    {
      category: 'proxy',
      eventId: 'deleted',
      match: (p) => p.action === 'deleted',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain }),
    },
    {
      category: 'proxy',
      eventId: 'health.offline',
      match: (p) => p.action === 'health.offline',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain }),
      extractData: (p) => ({ health_status: p.health_status }),
    },
    {
      category: 'proxy',
      eventId: 'health.degraded',
      match: (p) => p.action === 'health.degraded',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain }),
      extractData: (p) => ({ health_status: p.health_status }),
    },
    {
      category: 'proxy',
      eventId: 'health.online',
      match: (p) => p.action === 'health.online',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain }),
      extractData: (p) => ({ health_status: p.health_status }),
    },
  ],
  'proxy.secure-link.changed': [
    {
      category: 'proxy',
      eventId: 'secure_link.provisioning_failed',
      match: (p) => p.phase === 'provisioning' && p.state === 'failed',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain ?? p.id }),
      extractData: (p) => ({ failure_code: p.failureCode ?? null, operation_phase: p.phase }),
    },
    {
      category: 'proxy',
      eventId: 'secure_link.reconciliation_failed',
      match: (p) => p.phase === 'reconciliation',
      extractResource: (p) => ({ type: 'proxy', id: p.id, name: p.domain ?? p.id }),
      extractData: (p) => ({ failure_code: p.failureCode ?? null, operation_phase: p.phase }),
      stateful: {
        currentState: (p) =>
          p.state === 'failed' ? 'secure_link.reconciliation_failed' : 'secure_link.reconciliation_healthy',
        observedPatterns: ['secure_link.reconciliation_failed'],
      },
    },
  ],
  'docker.deployment.changed': [
    {
      category: 'container',
      eventId: 'deployment.failed',
      match: (p) =>
        ['failed', 'created', 'updated', 'switched', 'started', 'stopped', 'restarted', 'killed', 'deleted'].includes(
          p.action
        ),
      extractResource: (p) => ({ type: 'docker_deployment', id: p.deploymentId, name: p.name ?? p.deploymentId }),
      extractData: (p) => ({
        nodeId: p.nodeId,
        failure_code: p.failureCode ?? (p.action === 'failed' ? 'deployment_failed' : null),
        operation_kind: p.operation ?? p.action,
        operation_trigger: p.trigger ?? null,
      }),
      stateful: {
        currentState: (p) => (p.action === 'failed' ? 'deployment.failed' : 'deployment.healthy'),
        observedPatterns: ['deployment.failed'],
      },
    },
  ],
  'docker.migration.changed': [
    {
      category: 'container',
      eventId: 'migration.failed',
      match: (p) => p.status === 'failed',
      extractResource: (p) => ({ type: 'docker_migration', id: p.id, name: p.resourceName ?? p.id }),
      extractData: (p) => ({
        failure_code: p.errorCode ?? 'migration_failed',
        operation_phase: p.phase,
        source_node_id: p.sourceNodeId,
        target_node_id: p.targetNodeId,
      }),
    },
    {
      category: 'container',
      eventId: 'migration.needs_attention',
      match: () => true,
      extractResource: (p) => ({ type: 'docker_migration', id: p.id, name: p.resourceName ?? p.id }),
      extractData: (p) => ({ failure_code: p.errorCode ?? null, operation_phase: p.phase }),
      stateful: {
        currentState: (p) =>
          p.status === 'needs_attention' ? 'migration.needs_attention' : 'migration.attention_cleared',
        observedPatterns: ['migration.needs_attention'],
      },
    },
  ],
  'docker.container.changed': [
    {
      category: 'container',
      eventId: 'started',
      match: (p) => p.action === 'started',
      extractResource: (p) => ({ type: 'container', id: p.id, name: p.name }),
      extractData: (p) => ({ nodeId: p.nodeId }),
    },
    {
      category: 'container',
      eventId: 'stopped',
      match: (p) => p.action === 'stopped',
      extractResource: (p) => ({ type: 'container', id: p.id, name: p.name }),
      extractData: (p) => ({ nodeId: p.nodeId }),
    },
    {
      category: 'container',
      eventId: 'exited',
      match: (p) => p.action === 'killed',
      extractResource: (p) => ({ type: 'container', id: p.id, name: p.name }),
      extractData: (p) => ({ nodeId: p.nodeId }),
    },
  ],
  'docker.health.changed': [
    {
      category: 'container',
      eventId: 'health.offline',
      match: (p) => p.action === 'health.offline',
      extractResource: (p) => ({
        type: p.resourceType ?? (p.target === 'deployment' ? 'docker_deployment' : 'docker_container'),
        id: p.target === 'deployment' ? p.deploymentId : p.containerName,
        name: p.name ?? p.containerName ?? p.deploymentId,
      }),
      extractData: (p) => ({ health_status: p.health_status ?? p.healthStatus, nodeId: p.nodeId }),
    },
    {
      category: 'container',
      eventId: 'health.degraded',
      match: (p) => p.action === 'health.degraded',
      extractResource: (p) => ({
        type: p.resourceType ?? (p.target === 'deployment' ? 'docker_deployment' : 'docker_container'),
        id: p.target === 'deployment' ? p.deploymentId : p.containerName,
        name: p.name ?? p.containerName ?? p.deploymentId,
      }),
      extractData: (p) => ({ health_status: p.health_status ?? p.healthStatus, nodeId: p.nodeId }),
    },
    {
      category: 'container',
      eventId: 'health.online',
      match: (p) => p.action === 'health.online',
      extractResource: (p) => ({
        type: p.resourceType ?? (p.target === 'deployment' ? 'docker_deployment' : 'docker_container'),
        id: p.target === 'deployment' ? p.deploymentId : p.containerName,
        name: p.name ?? p.containerName ?? p.deploymentId,
      }),
      extractData: (p) => ({ health_status: p.health_status ?? p.healthStatus, nodeId: p.nodeId }),
    },
  ],
  'database.changed': [
    ...(['postgres', 'clickhouse', 'redis'] as const).map(
      (type): EventMapping => ({
        category: `database_${type}` as AlertCategory,
        eventId: 'binding.provisioning_failed',
        match: (p) =>
          p.resourceKind === 'managed_database_binding' &&
          p.type === type &&
          ['binding.error', 'binding.ready', 'binding.deleted'].includes(p.action) &&
          (p.failurePhase === 'provisioning' || p.action !== 'binding.error'),
        extractResource: (p) => ({ type: 'managed_database_binding', id: p.bindingId, name: p.name ?? p.bindingId }),
        extractData: (p) => ({
          failure_code: p.failureCode ?? null,
          operation_phase: p.failurePhase ?? 'provisioning',
          database_id: p.managedDatabaseId,
          target_node_id: p.targetNodeId,
          target_type: p.targetType,
          target_id: p.targetResourceId,
        }),
        stateful: {
          currentState: (p) =>
            p.action === 'binding.error' ? 'binding.provisioning_failed' : 'binding.provisioning_healthy',
          observedPatterns: ['binding.provisioning_failed'],
        },
      })
    ),
    ...(['postgres', 'clickhouse', 'redis'] as const).map(
      (type): EventMapping => ({
        category: `database_${type}` as AlertCategory,
        eventId: 'binding.reconciliation_failed',
        match: (p) =>
          p.resourceKind === 'managed_database_binding' &&
          p.type === type &&
          ['binding.reconciliation_failed', 'binding.reconciliation_ready'].includes(p.action),
        extractResource: (p) => ({ type: 'managed_database_binding', id: p.bindingId, name: p.name ?? p.bindingId }),
        extractData: (p) => ({
          failure_code: p.failureCode ?? null,
          operation_phase: 'reconciliation',
          database_id: p.managedDatabaseId,
          target_node_id: p.targetNodeId,
          target_type: p.targetType,
          target_id: p.targetResourceId,
        }),
        stateful: {
          currentState: (p) =>
            p.action === 'binding.reconciliation_failed'
              ? 'binding.reconciliation_failed'
              : 'binding.reconciliation_healthy',
          observedPatterns: ['binding.reconciliation_failed'],
        },
      })
    ),
    ...(['postgres', 'clickhouse', 'redis'] as const).flatMap((type) => {
      const category = `database_${type}` as AlertCategory;
      return ['created', 'ready', 'stopped', 'error', 'deleted'].map(
        (eventId): EventMapping => ({
          category,
          eventId,
          match: (p) => p.type === type && p.action === eventId && !!(p.managedDatabaseId ?? p.databaseId),
          extractResource: (p) => ({
            type: 'database',
            id: p.managedDatabaseId ?? p.databaseId,
            name: p.name,
          }),
          // Keep notification payloads safe: lifecycle events never forward
          // daemon errors, credentials, endpoint data, or connector metadata.
          extractData: (p) => ({ status: p.status ?? eventId }),
        })
      );
    }),
    {
      category: 'database_postgres',
      eventId: 'health.offline',
      match: (p) => p.action === 'health.offline' && p.type === 'postgres',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_postgres',
      eventId: 'health.degraded',
      match: (p) => p.action === 'health.degraded' && p.type === 'postgres',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_postgres',
      eventId: 'health.online',
      match: (p) => p.action === 'health.online' && p.type === 'postgres',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_clickhouse',
      eventId: 'health.offline',
      match: (p) => p.action === 'health.offline' && p.type === 'clickhouse',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_clickhouse',
      eventId: 'health.degraded',
      match: (p) => p.action === 'health.degraded' && p.type === 'clickhouse',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_clickhouse',
      eventId: 'health.online',
      match: (p) => p.action === 'health.online' && p.type === 'clickhouse',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_redis',
      eventId: 'health.offline',
      match: (p) => p.action === 'health.offline' && p.type === 'redis',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_redis',
      eventId: 'health.degraded',
      match: (p) => p.action === 'health.degraded' && p.type === 'redis',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
    {
      category: 'database_redis',
      eventId: 'health.online',
      match: (p) => p.action === 'health.online' && p.type === 'redis',
      extractResource: (p) => ({ type: 'database', id: p.id, name: p.name }),
      extractData: (p) => ({ health_status: p.healthStatus }),
    },
  ],
};
