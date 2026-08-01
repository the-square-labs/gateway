// ── Notifications ──────────────────────────────────────────────────

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  type: "threshold" | "event";
  category:
    | "node"
    | "container"
    | "proxy"
    | "certificate"
    | "database_postgres"
    | "database_clickhouse"
    | "database_redis";
  severity: "info" | "warning" | "critical";
  metric: string | null;
  metricTarget: string | null;
  operator: string | null;
  thresholdValue: number | null;
  durationSeconds: number;
  fireThresholdPercent: number;
  resolveAfterSeconds: number;
  resolveThresholdPercent: number;
  eventPattern: string | null;
  resourceIds: string[];
  messageTemplate: string | null;
  webhookIds: string[];
  cooldownSeconds: number;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationWebhook {
  id: string;
  name: string;
  url: string;
  method: string;
  enabled: boolean;
  signingSecret: string | null;
  signingHeader: string | null;
  templatePreset: string | null;
  bodyTemplate: string | null;
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  webhookName: string | null;
  eventType: string;
  severity: string;
  requestUrl: string;
  requestMethod: string;
  requestBody: string | null;
  requestBodyPreview?: string | null;
  requestBodyTruncated?: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  responseBodyPreview?: string | null;
  responseBodyTruncated?: boolean;
  responseTimeMs: number | null;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  status: "pending" | "success" | "failed" | "retrying";
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WebhookPreset {
  id: string;
  name: string;
  description: string;
  urlHint: string;
  defaultHeaders: Record<string, string>;
  bodyTemplate: string;
}

export interface AlertCategoryDef {
  id: string;
  label: string;
  metrics: Array<{
    id: string;
    label: string;
    unit: string;
    defaultOperator: string;
    defaultValue: number;
    defaultDurationSeconds?: number;
    defaultResolveAfterSeconds?: number;
  }>;
  events: Array<{
    id: string;
    label: string;
    defaultSeverity: string;
    supportsThreshold?: boolean;
  }>;
  variables: Array<{ name: string; description: string }>;
}
