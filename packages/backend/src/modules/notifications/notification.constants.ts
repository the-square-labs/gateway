/**
 * Notification system constants: event catalog, default alert rules,
 * severity definitions, and metric/event definitions per category.
 */

// ── Severity ──────────────────────────────────────────────────────────

export type Severity = 'info' | 'warning' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function severityMeetsMinimum(actual: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER[actual] >= SEVERITY_ORDER[minimum];
}

export const SEVERITY_EMOJI: Record<Severity, string> = {
  info: '\u2139\uFE0F',
  warning: '\u26A0\uFE0F',
  critical: '\uD83D\uDEA8',
};

export const SEVERITY_COLOR: Record<Severity, number> = {
  info: 3447003,
  warning: 16776960,
  critical: 15158332,
};

// ── Alert Categories ──────────────────────────────────────────────────

export type AlertCategory =
  | 'node'
  | 'container'
  | 'proxy'
  | 'pages'
  | 'gateway'
  | 'logging'
  | 'integration'
  | 'certificate'
  | 'security'
  | 'database_postgres'
  | 'database_clickhouse'
  | 'database_redis';

export interface MetricDefinition {
  id: string;
  label: string;
  unit: string;
  defaultOperator: string;
  defaultValue: number;
  defaultDurationSeconds?: number;
  defaultResolveAfterSeconds?: number;
}

export interface EventDefinition {
  id: string;
  label: string;
  defaultSeverity: Severity;
  supportsThreshold?: boolean;
}

export interface CategoryDefinition {
  id: AlertCategory;
  label: string;
  metrics: MetricDefinition[];
  events: EventDefinition[];
  /** Variables available in message templates for this category */
  variables: Array<{ name: string; description: string }>;
}

const GPU_NODE_METRIC_IDS = new Set([
  'gpu_utilization_percent',
  'gpu_memory_used_percent',
  'gpu_temperature_celsius',
  'gpu_power_percent_of_limit',
  'gpu_throttled',
  'gpu_health_degraded',
  'gpu_ecc_corrected_errors',
  'gpu_ecc_uncorrected_errors',
]);

/** Node metrics which maintain one alert state per physical GPU device. */
export function isPerDeviceNodeMetric(metric: string): boolean {
  return GPU_NODE_METRIC_IDS.has(metric);
}

export const ALERT_CATEGORIES: CategoryDefinition[] = [
  {
    id: 'node',
    label: 'Node',
    metrics: [
      { id: 'cpu', label: 'CPU Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'memory', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'disk', label: 'Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 85 },
      {
        id: 'gpu_utilization_percent',
        label: 'GPU Utilization (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'gpu_memory_used_percent',
        label: 'GPU VRAM Usage (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'gpu_temperature_celsius',
        label: 'GPU Temperature',
        unit: '°C',
        defaultOperator: '>',
        defaultValue: 85,
      },
      {
        id: 'gpu_power_percent_of_limit',
        label: 'GPU Power (% of Limit)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 95,
      },
      { id: 'gpu_throttled', label: 'GPU Throttled', unit: 'state', defaultOperator: '>=', defaultValue: 1 },
      {
        id: 'gpu_health_degraded',
        label: 'GPU Health Degraded',
        unit: 'state',
        defaultOperator: '>=',
        defaultValue: 1,
      },
      {
        id: 'gpu_ecc_corrected_errors',
        label: 'GPU Corrected ECC Errors',
        unit: 'errors',
        defaultOperator: '>',
        defaultValue: 0,
      },
      {
        id: 'gpu_ecc_uncorrected_errors',
        label: 'GPU Uncorrected ECC Errors',
        unit: 'errors',
        defaultOperator: '>',
        defaultValue: 0,
      },
    ],
    events: [
      { id: 'offline', label: 'Node Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'online', label: 'Node Online', defaultSeverity: 'info', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Node hostname' },
      { name: '{{resource.id}}', description: 'Node ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{node.id}}', description: 'Node ID' },
      { name: '{{node.name}}', description: 'Node hostname' },
      { name: '{{metric.name}}', description: 'Metric name (CPU, memory, disk, or GPU metric)' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{metric.duration}}', description: 'Configured fire-after duration' },
      { name: '{{fired.at}}', description: 'When the alert started firing' },
      { name: '{{fired.duration}}', description: 'How long alert has been firing' },
    ],
  },
  {
    id: 'container',
    label: 'Container',
    metrics: [
      { id: 'cpu', label: 'CPU Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'memory', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
    ],
    events: [
      { id: 'stopped', label: 'Container Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'started', label: 'Container Started', defaultSeverity: 'info' },
      { id: 'exited', label: 'Container Exited', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.offline', label: 'Health Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Health Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Health Online', defaultSeverity: 'info', supportsThreshold: true },
      {
        id: 'dependency.database_offline',
        label: 'Database Secure Link Offline',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'deployment.failed', label: 'Deployment Failed', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'migration.failed', label: 'Migration Failed', defaultSeverity: 'critical' },
      {
        id: 'migration.needs_attention',
        label: 'Migration Needs Attention',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Container name' },
      { name: '{{resource.id}}', description: 'Container ID when known' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{node.id}}', description: 'Docker node ID' },
      { name: '{{node.name}}', description: 'Node hosting this container' },
      { name: '{{metric.name}}', description: 'Metric name (cpu, memory)' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{health.status}}', description: 'HTTP health status' },
      { name: '{{fired.at}}', description: 'When the alert started firing' },
      { name: '{{fired.duration}}', description: 'How long alert has been firing' },
    ],
  },
  {
    id: 'proxy',
    label: 'Proxy Host',
    metrics: [],
    events: [
      { id: 'health.offline', label: 'Health Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Health Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Health Online', defaultSeverity: 'info', supportsThreshold: true },
      { id: 'maintenance.active', label: 'Maintenance Active', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'created', label: 'Proxy Created', defaultSeverity: 'info' },
      { id: 'deleted', label: 'Proxy Deleted', defaultSeverity: 'info' },
      { id: 'secure_link.provisioning_failed', label: 'Secure Link Provisioning Failed', defaultSeverity: 'critical' },
      {
        id: 'secure_link.reconciliation_failed',
        label: 'Secure Link Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Domain name(s)' },
      { name: '{{resource.id}}', description: 'Proxy host ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{health.status}}', description: 'Health status' },
      { name: '{{event.name}}', description: 'Event pattern/name' },
      { name: '{{state.current}}', description: 'Current state for stateful events' },
    ],
  },
  {
    id: 'pages',
    label: 'Pages',
    metrics: [],
    events: [
      { id: 'deployment.ready', label: 'Deployment Ready', defaultSeverity: 'info' },
      { id: 'deployment.failed', label: 'Deployment Failed', defaultSeverity: 'critical' },
      { id: 'publication.failed', label: 'Tag Publication Failed', defaultSeverity: 'critical' },
      { id: 'config.publication_failed', label: 'Runtime Config Publication Failed', defaultSeverity: 'critical' },
      { id: 'quota.blocked', label: 'Project Quota Blocked', defaultSeverity: 'warning', supportsThreshold: true },
      {
        id: 'profile.unavailable',
        label: 'Wildcard Profile Unavailable',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'capability.missing',
        label: 'Pages Daemon Capability Missing',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'migration.failed', label: 'Ingress Migration Failed', defaultSeverity: 'critical' },
      {
        id: 'migration.needs_attention',
        label: 'Ingress Migration Needs Attention',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'cleanup.needs_attention',
        label: 'Cleanup Needs Attention',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Page Project name' },
      { name: '{{resource.id}}', description: 'Page Project ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{event.name}}', description: 'Pages event name' },
      { name: '{{state.current}}', description: 'Current Pages condition' },
      { name: '{{operation.kind}}', description: 'Deployment, publication, cleanup, or migration operation' },
      { name: '{{operation.phase}}', description: 'Current operation phase' },
      { name: '{{failure.code}}', description: 'Stable public failure code' },
      { name: '{{details.public_slug}}', description: 'Immutable Deployment public hash' },
      { name: '{{details.tag}}', description: 'Tag name' },
      { name: '{{details.quota_used_bytes}}', description: 'Current canonical storage usage' },
      { name: '{{details.quota_limit_bytes}}', description: 'Project canonical storage quota' },
    ],
  },
  {
    id: 'gateway',
    label: 'Gateway',
    metrics: [],
    events: [
      { id: 'relay.recovering', label: 'Relay Recovering', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'relay.unavailable', label: 'Relay Unavailable', defaultSeverity: 'critical', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Gateway component name' },
      { name: '{{state.current}}', description: 'Current relay state' },
      { name: '{{failure.code}}', description: 'Stable failure code' },
      { name: '{{details.attempt}}', description: 'Recovery attempt' },
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    metrics: [
      {
        id: 'error_fatal_ratio_percent',
        label: 'Error + Fatal Ratio (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 10,
      },
      {
        id: 'fatal_ratio_percent',
        label: 'Fatal Ratio (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 1,
      },
    ],
    events: [
      { id: 'storage.pressure', label: 'Storage Pressure', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'storage.degraded', label: 'Storage Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'storage.exhausted', label: 'Storage Exhausted', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'storage.unavailable', label: 'Storage Unavailable', defaultSeverity: 'critical', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Logging environment or storage' },
      { name: '{{metric.name}}', description: 'Logging metric name' },
      { name: '{{metric.value}}', description: 'Current ratio' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{state.current}}', description: 'Current storage state' },
    ],
  },
  {
    id: 'integration',
    label: 'Integration',
    metrics: [],
    events: [
      { id: 'sync.failed', label: 'Connector Sync Failed', defaultSeverity: 'warning', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Integration connector' },
      { name: '{{state.current}}', description: 'Current connector state' },
      { name: '{{failure.code}}', description: 'Stable failure code' },
      { name: '{{details.provider}}', description: 'Connector provider' },
      { name: '{{details.failure_count}}', description: 'Consecutive failures' },
    ],
  },
  {
    id: 'certificate',
    label: 'Certificate',
    metrics: [
      {
        id: 'days_until_expiry',
        label: 'Days Until Expiry',
        unit: 'days',
        defaultOperator: '<=',
        defaultValue: 14,
        defaultDurationSeconds: 0,
        defaultResolveAfterSeconds: 0,
      },
    ],
    events: [
      { id: 'issued', label: 'Certificate Issued', defaultSeverity: 'info' },
      { id: 'renewed', label: 'Certificate Renewed', defaultSeverity: 'info' },
      { id: 'renewal_failed', label: 'Certificate Renewal Failed', defaultSeverity: 'critical' },
      { id: 'expired', label: 'Certificate Expired', defaultSeverity: 'critical' },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Certificate domain(s)' },
      { name: '{{resource.id}}', description: 'Certificate ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{certificate.days_until_expiry}}', description: 'Days until expiry' },
      { name: '{{certificate.expiry_date}}', description: 'Expiry date' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{fired.at}}', description: 'When the alert started firing' },
      { name: '{{fired.duration}}', description: 'How long alert has been firing' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    metrics: [],
    events: [{ id: 'mfa.required', label: 'Group MFA Required', defaultSeverity: 'warning' }],
    variables: [
      { name: '{{resource.name}}', description: 'Permission group name' },
      { name: '{{resource.id}}', description: 'Permission group ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{event.name}}', description: 'Event pattern/name' },
    ],
  },
  {
    id: 'database_postgres',
    label: 'Database - Postgres',
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      {
        id: 'active_connections_pct',
        label: 'Active Connections (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'database_size_mb',
        label: 'Database Size (MB)',
        unit: 'MB',
        defaultOperator: '>',
        defaultValue: 1024,
      },
    ],
    events: [
      { id: 'created', label: 'Managed Database Created', defaultSeverity: 'info' },
      { id: 'ready', label: 'Managed Database Ready', defaultSeverity: 'info' },
      { id: 'stopped', label: 'Managed Database Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'error', label: 'Managed Database Error', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'deleted', label: 'Managed Database Deleted', defaultSeverity: 'info' },
      { id: 'health.offline', label: 'Database Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Database Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Database Online', defaultSeverity: 'info', supportsThreshold: true },
      {
        id: 'binding.provisioning_failed',
        label: 'Database Binding Provisioning Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'binding.reconciliation_failed',
        label: 'Database Binding Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database connection name' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{health.status}}', description: 'Health status' },
    ],
  },
  {
    id: 'database_clickhouse',
    label: 'Database - ClickHouse',
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      {
        id: 'database_size_mb',
        label: 'Database Size (MB)',
        unit: 'MB',
        defaultOperator: '>',
        defaultValue: 1024,
      },
      { id: 'disk_used_pct', label: 'Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      {
        id: 'disk_available_mb',
        label: 'Disk Available (MB)',
        unit: 'MB',
        defaultOperator: '<',
        defaultValue: 10_240,
      },
      { id: 'pending_mutations', label: 'Pending Mutations', unit: '', defaultOperator: '>', defaultValue: 5 },
    ],
    events: [
      { id: 'created', label: 'Managed Database Created', defaultSeverity: 'info' },
      { id: 'ready', label: 'Managed Database Ready', defaultSeverity: 'info' },
      { id: 'stopped', label: 'Managed Database Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'error', label: 'Managed Database Error', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'deleted', label: 'Managed Database Deleted', defaultSeverity: 'info' },
      { id: 'health.offline', label: 'Database Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Database Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Database Online', defaultSeverity: 'info', supportsThreshold: true },
      {
        id: 'binding.provisioning_failed',
        label: 'Database Binding Provisioning Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'binding.reconciliation_failed',
        label: 'Database Binding Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database connection name' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{health.status}}', description: 'Health status' },
    ],
  },
  {
    id: 'database_redis',
    label: 'Database - Redis',
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      { id: 'memory_pct', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
    ],
    events: [
      { id: 'created', label: 'Managed Database Created', defaultSeverity: 'info' },
      { id: 'ready', label: 'Managed Database Ready', defaultSeverity: 'info' },
      { id: 'stopped', label: 'Managed Database Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'error', label: 'Managed Database Error', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'deleted', label: 'Managed Database Deleted', defaultSeverity: 'info' },
      { id: 'health.offline', label: 'Database Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Database Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Database Online', defaultSeverity: 'info', supportsThreshold: true },
      {
        id: 'binding.provisioning_failed',
        label: 'Database Binding Provisioning Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'binding.reconciliation_failed',
        label: 'Database Binding Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database connection name' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{health.status}}', description: 'Health status' },
    ],
  },
];

export const CATEGORY_MAP = new Map(ALERT_CATEGORIES.map((c) => [c.id, c]));

export function eventSupportsThreshold(category: AlertCategory, eventId: string): boolean {
  return CATEGORY_MAP.get(category)?.events.some((event) => event.id === eventId && event.supportsThreshold) ?? false;
}

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

// ── Threshold Metric Extraction ───────────────────────────────────────

/** Given a category + metric, extract its value from a health report */
export function extractMetricFromHealthReport(
  category: string,
  metric: string,
  healthData: any,
  metricTarget?: string | null
): { values: Array<{ resourceId: string; value: number }> } | null {
  if (category === 'node') {
    switch (metric) {
      case 'cpu': {
        const cpu = healthData.cpuPercent ?? healthData.cpu_percent;
        if (typeof cpu !== 'number') return null;
        return { values: [{ resourceId: 'system', value: cpu }] };
      }
      case 'memory': {
        const total = healthData.systemMemoryTotalBytes ?? healthData.system_memory_total_bytes ?? 0;
        const used = healthData.systemMemoryUsedBytes ?? healthData.system_memory_used_bytes ?? 0;
        if (!total) return null;
        return { values: [{ resourceId: 'system', value: (used / total) * 100 }] };
      }
      case 'disk': {
        const mounts: any[] = healthData.diskMounts ?? healthData.disk_mounts ?? [];
        if (!Array.isArray(mounts) || mounts.length === 0) {
          const free = healthData.diskFreeBytes ?? healthData.disk_free_bytes;
          const total = healthData.diskTotalBytes ?? healthData.disk_total_bytes;
          if (typeof free !== 'number' || typeof total !== 'number' || total === 0) return null;
          if (metricTarget && metricTarget !== '/') return null;
          return { values: [{ resourceId: '/', value: ((total - free) / total) * 100 }] };
        }
        const normalizedTarget = metricTarget?.trim() || null;
        const filteredMounts = normalizedTarget
          ? mounts.filter((m: any) => (m.mountPoint ?? m.mount_point ?? '/') === normalizedTarget)
          : mounts;
        if (filteredMounts.length === 0) return null;
        return {
          values: filteredMounts.map((m: any) => ({
            resourceId: m.mountPoint ?? m.mount_point ?? '/',
            value: m.usagePercent ?? m.usage_percent ?? 0,
          })),
        };
      }
    }

    if (isPerDeviceNodeMetric(metric)) {
      return extractGpuMetricFromHealthReport(metric, healthData, metricTarget);
    }
  }

  if (category === 'container') {
    const stats: any[] = healthData.containerStats ?? healthData.container_stats ?? [];
    if (!Array.isArray(stats)) return null;
    const metricStats = stats.filter((s: any) => s.metricsAvailable !== false && s.metrics_available !== false);
    switch (metric) {
      case 'cpu':
        return {
          values: metricStats.map((s: any) => ({
            resourceId: s.name ?? s.containerId ?? '',
            value: s.cpuPercent ?? s.cpu_percent ?? 0,
          })),
        };
      case 'memory':
        return {
          values: metricStats.map((s: any) => {
            const used = s.memoryUsageBytes ?? s.memory_usage_bytes ?? 0;
            const limit = s.memoryLimitBytes ?? s.memory_limit_bytes ?? 0;
            return {
              resourceId: s.name ?? s.containerId ?? '',
              value: limit > 0 ? (used / limit) * 100 : 0,
            };
          }),
        };
    }
  }

  return null;
}

function gpuMetricIsAvailable(device: Record<string, unknown>, metric: string): boolean {
  const availableMetrics = device.availableMetrics ?? device.available_metrics;
  return (
    Array.isArray(availableMetrics) &&
    availableMetrics.some((candidate) => typeof candidate === 'string' && candidate.trim() === metric)
  );
}

function gpuNumberMetric(device: Record<string, unknown>, availability: string, ...fields: string[]): number | null {
  if (!gpuMetricIsAvailable(device, availability)) return null;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function gpuBooleanMetric(device: Record<string, unknown>, availability: string, ...fields: string[]): boolean | null {
  if (!gpuMetricIsAvailable(device, availability)) return null;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  return typeof raw === 'boolean' ? raw : null;
}

function gpuHealthMetric(device: Record<string, unknown>): string | null {
  if (!gpuMetricIsAvailable(device, 'health')) return null;
  const raw = device.health;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

/**
 * GPU telemetry is capability-aware. Unlike legacy host metrics, each field
 * is unavailable until the daemon explicitly reports it in availableMetrics.
 */
function extractGpuMetricFromHealthReport(
  metric: string,
  healthData: any,
  metricTarget?: string | null
): { values: Array<{ resourceId: string; value: number }> } | null {
  const devices = healthData.gpuDevices ?? healthData.gpu_devices;
  if (!Array.isArray(devices)) return null;

  const target = metricTarget?.trim() || null;
  const values = devices.flatMap((rawDevice: unknown) => {
    if (!rawDevice || typeof rawDevice !== 'object') return [];
    const device = rawDevice as Record<string, unknown>;
    const idValue = device.id ?? device.Id;
    const resourceId = typeof idValue === 'string' ? idValue.trim() : '';
    if (!resourceId || (target && resourceId !== target)) return [];

    let value: number | null = null;
    switch (metric) {
      case 'gpu_utilization_percent':
        value = gpuNumberMetric(device, 'utilization_percent', 'utilizationPercent', 'utilization_percent');
        break;
      case 'gpu_memory_used_percent': {
        const total = gpuNumberMetric(device, 'memory_total_bytes', 'memoryTotalBytes', 'memory_total_bytes');
        const used = gpuNumberMetric(device, 'memory_used_bytes', 'memoryUsedBytes', 'memory_used_bytes');
        value = total !== null && total > 0 && used !== null ? (used / total) * 100 : null;
        break;
      }
      case 'gpu_temperature_celsius':
        value = gpuNumberMetric(device, 'temperature_celsius', 'temperatureCelsius', 'temperature_celsius');
        break;
      case 'gpu_power_percent_of_limit': {
        const power = gpuNumberMetric(device, 'power_watts', 'powerWatts', 'power_watts');
        const limit = gpuNumberMetric(device, 'power_limit_watts', 'powerLimitWatts', 'power_limit_watts');
        value = power !== null && limit !== null && limit > 0 ? (power / limit) * 100 : null;
        break;
      }
      case 'gpu_throttled': {
        const throttled = gpuBooleanMetric(device, 'throttled', 'throttled');
        value = throttled === null ? null : throttled ? 1 : 0;
        break;
      }
      case 'gpu_health_degraded': {
        const health = gpuHealthMetric(device);
        value = health === null ? null : health === 'healthy' ? 0 : 1;
        break;
      }
      case 'gpu_ecc_corrected_errors':
        value = gpuNumberMetric(device, 'ecc_corrected_errors', 'eccCorrectedErrors', 'ecc_corrected_errors');
        break;
      case 'gpu_ecc_uncorrected_errors':
        value = gpuNumberMetric(device, 'ecc_uncorrected_errors', 'eccUncorrectedErrors', 'ecc_uncorrected_errors');
        break;
    }

    return value !== null && Number.isFinite(value) ? [{ resourceId, value }] : [];
  });

  return values.length > 0 ? { values } : null;
}

export function extractMetricFromDatabaseSnapshot(
  category: string,
  metric: string,
  snapshot: { databaseId: string; metrics: Record<string, number | null> }
): { values: Array<{ resourceId: string; value: number }> } | null {
  if (category !== 'database_postgres' && category !== 'database_clickhouse' && category !== 'database_redis') {
    return null;
  }
  const value = snapshot.metrics[metric];
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return { values: [{ resourceId: snapshot.databaseId, value }] };
}

/** Evaluate a threshold condition */
export function evaluateThreshold(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    default:
      return false;
  }
}

export interface WindowProbeSample {
  timestamp: number;
  breached: boolean;
}

export interface WindowRatioEvaluation {
  hasCoverage: boolean;
  sampleCount: number;
  matchingSamples: number;
  ratioPercent: number;
  thresholdMet: boolean;
}

export function evaluateWindowRatio(
  samples: WindowProbeSample[],
  targetState: 'breach' | 'clear',
  thresholdPercent: number,
  windowMs: number,
  now = Date.now()
): WindowRatioEvaluation {
  if (samples.length === 0) {
    return {
      hasCoverage: windowMs === 0,
      sampleCount: 0,
      matchingSamples: 0,
      ratioPercent: 0,
      thresholdMet: false,
    };
  }

  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const oldestTimestamp = sorted[0]?.timestamp ?? now;
  const hasCoverage = windowMs === 0 || oldestTimestamp <= now - windowMs;
  const matchingSamples = sorted.filter((sample) =>
    targetState === 'breach' ? sample.breached : !sample.breached
  ).length;
  const ratioPercent = (matchingSamples / sorted.length) * 100;

  return {
    hasCoverage,
    sampleCount: sorted.length,
    matchingSamples,
    ratioPercent,
    thresholdMet: hasCoverage && ratioPercent >= thresholdPercent,
  };
}
