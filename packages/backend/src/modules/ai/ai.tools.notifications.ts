import type { AIToolDefinition } from './ai.types.js';

export const NOTIFICATION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_alert_rules',
    description:
      'List all notification alert rules. Returns id, name, enabled, type (threshold/event), category (node/container/proxy/gateway/logging/integration/certificate/database_postgres/database_clickhouse/database_redis), severity, metric, operator, thresholdValue, eventPattern, resourceIds, webhookIds, cooldownSeconds.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'node',
            'container',
            'proxy',
            'certificate',
            'database_postgres',
            'database_clickhouse',
            'database_redis',
          ],
          description: 'Filter by category',
        },
        enabled: { type: 'boolean', description: 'Filter by enabled/disabled' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:view',
    invalidateStores: [],
  },
  {
    name: 'get_alert_rule',
    description: 'Get detailed information about a specific alert rule by ID.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Alert rule UUID' },
      },
      required: ['ruleId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:view',
    invalidateStores: [],
  },
  {
    name: 'create_alert_rule',
    description:
      'Create a new notification alert rule. Threshold rules fire when a metric crosses a value. Event rules fire on system events like node offline or container stopped.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Alert name (e.g., "CPU High")' },
        type: { type: 'string', enum: ['threshold', 'event'], description: 'Rule type' },
        category: {
          type: 'string',
          enum: [
            'node',
            'container',
            'proxy',
            'certificate',
            'database_postgres',
            'database_clickhouse',
            'database_redis',
          ],
          description: 'Resource category',
        },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Alert severity' },
        metric: { type: 'string', description: 'For threshold: metric name (cpu, memory, disk, days_until_expiry)' },
        metricTarget: {
          type: 'string',
          description: 'For threshold: optional sub-target like a specific disk mount point',
        },
        operator: { type: 'string', enum: ['>', '>=', '<', '<='], description: 'For threshold: comparison operator' },
        thresholdValue: { type: 'number', description: 'For threshold: threshold value' },
        durationSeconds: {
          type: 'number',
          description: 'For threshold: observation window in seconds used for firing (0 = instant)',
        },
        fireThresholdPercent: {
          type: 'number',
          description:
            'For threshold: percent of probes in the fire window that must breach before firing (default 100)',
        },
        resolveAfterSeconds: {
          type: 'number',
          description: 'For threshold: observation window in seconds used for resolving (default 60)',
        },
        resolveThresholdPercent: {
          type: 'number',
          description:
            'For threshold: percent of probes in the resolve window that must be clear before resolving (default 100)',
        },
        eventPattern: { type: 'string', description: 'For event: event pattern (offline, stopped, oom_killed, etc.)' },
        resourceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Scope to specific resources (empty = all)',
        },
        messageTemplate: {
          type: 'string',
          description: 'Handlebars message template (e.g., "CPU at {{value}}% on {{resource.name}}")',
        },
        webhookIds: { type: 'array', items: { type: 'string' }, description: 'Webhook IDs to deliver to' },
        cooldownSeconds: { type: 'number', description: 'Cooldown between repeated firings (default 900)' },
        enabled: { type: 'boolean', description: 'Whether the rule is active (default true)' },
      },
      required: ['name', 'type', 'category', 'severity', 'webhookIds'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'update_alert_rule',
    description: 'Update an existing alert rule. Only include fields to change.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Alert rule UUID' },
        name: { type: 'string', description: 'New name' },
        enabled: { type: 'boolean', description: 'Enable/disable' },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        metric: { type: 'string' },
        metricTarget: { type: 'string' },
        operator: { type: 'string', enum: ['>', '>=', '<', '<='] },
        thresholdValue: { type: 'number' },
        durationSeconds: { type: 'number' },
        fireThresholdPercent: { type: 'number' },
        resolveAfterSeconds: { type: 'number' },
        resolveThresholdPercent: { type: 'number' },
        eventPattern: { type: 'string' },
        resourceIds: { type: 'array', items: { type: 'string' } },
        messageTemplate: { type: 'string' },
        webhookIds: { type: 'array', items: { type: 'string' } },
        cooldownSeconds: { type: 'number' },
      },
      required: ['ruleId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'delete_alert_rule',
    description: 'Delete a notification alert rule.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Alert rule UUID' },
      },
      required: ['ruleId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'list_webhooks',
    description: 'List all notification webhooks. Returns id, name, url, method, enabled, templatePreset, headers.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:view',
    invalidateStores: [],
  },
  {
    name: 'create_webhook',
    description:
      'Create a notification webhook endpoint. Webhooks define where and how alert notifications are delivered (Discord, Slack, Telegram, or custom HTTP). Use template presets for quick setup.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Webhook name (e.g., "Discord Alerts")' },
        url: { type: 'string', description: 'HTTP URL to POST to' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'], description: 'HTTP method (default POST)' },
        templatePreset: {
          type: 'string',
          enum: ['discord', 'slack', 'telegram', 'json', 'plain'],
          description: 'Built-in template preset',
        },
        bodyTemplate: { type: 'string', description: 'Custom Handlebars body template (overrides preset)' },
        signingSecret: { type: 'string', description: 'HMAC-SHA256 signing secret (optional)' },
        signingHeader: { type: 'string', description: 'HMAC header name (default X-Signature-256)' },
      },
      required: ['name', 'url'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'update_webhook',
    description: 'Update an existing webhook. Only include fields to change.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Webhook UUID' },
        name: { type: 'string' },
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        enabled: { type: 'boolean' },
        templatePreset: { type: 'string' },
        bodyTemplate: { type: 'string' },
        signingSecret: { type: 'string' },
        signingHeader: { type: 'string' },
      },
      required: ['webhookId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'delete_webhook',
    description: 'Delete a notification webhook.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Webhook UUID' },
      },
      required: ['webhookId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'test_webhook',
    description:
      'Send a test notification to a webhook to verify it works. Returns success status, HTTP status code, and any error.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Webhook UUID' },
      },
      required: ['webhookId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:manage',
    invalidateStores: [],
  },
  {
    name: 'list_webhook_deliveries',
    description:
      'List recent webhook delivery attempts. Returns delivery status, HTTP response code, timing, retry info. Use to diagnose delivery failures.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Filter by webhook UUID' },
        status: {
          type: 'string',
          enum: ['success', 'failed', 'retrying', 'pending'],
          description: 'Filter by delivery status',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:view',
    invalidateStores: [],
  },
  {
    name: 'get_delivery_stats',
    description: 'Get delivery statistics (total, success, failed, retrying counts). Optionally filter by webhook.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Filter by webhook UUID' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:view',
    invalidateStores: [],
  },
  {
    name: 'list_siem_destinations',
    description:
      'List configured SIEM audit export destinations. Returns safe configuration metadata and delivery state; secrets are never returned.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Filter by enabled/disabled state' },
        search: { type: 'string', description: 'Filter by destination name' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'get_siem_destination',
    description:
      'Get safe details and current delivery state for a SIEM audit export destination. The configured secret is never returned.',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string', description: 'SIEM destination UUID' } },
      required: ['destinationId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'create_siem_destination',
    description:
      'Create a SIEM audit export destination. The URL must be HTTPS without credentials, query parameters, or fragments. The bearer token, HMAC secret, or custom header value is encrypted at rest and never returned. This sends Gateway audit metadata, never full audit details.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Operator-facing destination name' },
        url: { type: 'string', description: 'HTTPS collector endpoint without query parameters' },
        authType: {
          type: 'string',
          enum: ['bearer', 'hmac_sha256', 'custom_header'],
          description: 'Authentication mechanism',
        },
        customHeaderName: {
          type: 'string',
          description: 'HTTP header field name for custom_header authentication only',
        },
        secret: {
          type: 'string',
          description: 'One-time bearer token, HMAC secret, or custom header value; never repeat it in responses',
        },
        enabled: { type: 'boolean', description: 'Start delivery immediately (default true)' },
      },
      required: ['name', 'url', 'authType', 'secret'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'update_siem_destination',
    description:
      'Update a SIEM destination. Include secret only to replace it. Changing authType requires a new secret. custom_header requires customHeaderName. Disabling pauses queued and retrying deliveries; re-enabling resumes them.',
    parameters: {
      type: 'object',
      properties: {
        destinationId: { type: 'string', description: 'SIEM destination UUID' },
        name: { type: 'string' },
        url: { type: 'string', description: 'HTTPS collector endpoint without query parameters' },
        authType: { type: 'string', enum: ['bearer', 'hmac_sha256', 'custom_header'] },
        customHeaderName: {
          type: 'string',
          description: 'HTTP header field name for custom_header authentication only',
        },
        secret: { type: 'string', description: 'One-time replacement secret; never repeat it in responses' },
        enabled: { type: 'boolean', description: 'Enable or pause delivery' },
      },
      required: ['destinationId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'delete_siem_destination',
    description:
      'Soft-delete a SIEM destination and discard any outstanding deliveries. Historical terminal delivery records remain until audit retention cleanup.',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string', description: 'SIEM destination UUID' } },
      required: ['destinationId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'test_siem_destination',
    description:
      'Send one synthetic SIEM test event to verify a destination. It creates no audit-log row and no queued delivery, and never exposes collector response bodies.',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string', description: 'SIEM destination UUID' } },
      required: ['destinationId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'list_siem_deliveries',
    description:
      'List SIEM audit-export delivery records and safe delivery diagnostics. Payloads are only available through get_siem_delivery and never include audit details or secrets.',
    parameters: {
      type: 'object',
      properties: {
        destinationId: { type: 'string', description: 'Filter by SIEM destination UUID' },
        status: {
          type: 'string',
          enum: ['queued', 'delivering', 'retrying', 'delivered', 'failed', 'paused', 'discarded'],
          description: 'Filter by delivery lifecycle state',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'get_siem_delivery',
    description:
      'Get a SIEM delivery record, including its frozen privacy-reduced event and safe response metadata. It never returns secrets, full audit details, or collector response bodies.',
    parameters: {
      type: 'object',
      properties: { deliveryId: { type: 'string', description: 'SIEM delivery UUID' } },
      required: ['deliveryId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'requeue_siem_delivery',
    description:
      'Requeue one terminal failed SIEM delivery from attempt zero. It cannot requeue deliveries that were delivered, paused, or discarded.',
    parameters: {
      type: 'object',
      properties: { deliveryId: { type: 'string', description: 'Failed SIEM delivery UUID' } },
      required: ['deliveryId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
];

export const WEB_SEARCH_AI_TOOL: AIToolDefinition = {
  name: 'web_search',
  description:
    "Search the web for current information about PKI, certificates, protocols, or any topic. Use when the user asks about something you don't know or needs up-to-date information.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Max results (default 5, max 10)' },
    },
    required: ['query'],
  },
  destructive: false,
  category: 'Web Search',
  requiredScope: 'feat:ai:use',
  invalidateStores: [],
};
