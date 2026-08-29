/** Notification severity, category, metric, event, and template-variable catalog. */

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
  | 'build'
  | 'compose'
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
    id: 'build',
    label: 'Docker Build',
    metrics: [],
    events: [
      { id: 'succeeded', label: 'Build Succeeded', defaultSeverity: 'info' },
      { id: 'failed', label: 'Build Failed', defaultSeverity: 'critical' },
      { id: 'cancelled', label: 'Build Cancelled', defaultSeverity: 'warning' },
      { id: 'superseded', label: 'Build Superseded', defaultSeverity: 'info' },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Build target name' },
      { name: '{{resource.id}}', description: 'Build source binding ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{operation.phase}}', description: 'Build status' },
      { name: '{{failure.code}}', description: 'Build failure code' },
    ],
  },
  {
    id: 'compose',
    label: 'Compose Project',
    metrics: [],
    events: [
      { id: 'operation.succeeded', label: 'Operation Succeeded', defaultSeverity: 'info' },
      { id: 'operation.failed', label: 'Operation Failed', defaultSeverity: 'critical' },
      { id: 'operation.cancelled', label: 'Operation Cancelled', defaultSeverity: 'warning' },
      { id: 'revision.activated', label: 'Revision Activated', defaultSeverity: 'info' },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Compose project name' },
      { name: '{{resource.id}}', description: 'Compose project ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{operation.kind}}', description: 'Compose operation kind' },
      { name: '{{operation.phase}}', description: 'Compose operation phase' },
      { name: '{{failure.code}}', description: 'Compose failure message or code' },
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
      {
        id: 'license.expired_grace',
        label: 'License Expired (Grace Period)',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'license.unavailable',
        label: 'Paid License Unavailable',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'license.validation_warning',
        label: 'License Validation Warning',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Gateway component name' },
      { name: '{{state.current}}', description: 'Current relay state' },
      { name: '{{failure.code}}', description: 'Stable failure code' },
      { name: '{{details.attempt}}', description: 'Recovery attempt' },
      { name: '{{details.plan}}', description: 'Effective license plan' },
      { name: '{{details.expires_at}}', description: 'License expiration time' },
      { name: '{{details.grace_until}}', description: 'License grace deadline' },
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
