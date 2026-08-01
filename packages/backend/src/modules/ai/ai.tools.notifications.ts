import type { AIToolDefinition } from './ai.types.js';

export const NOTIFICATION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_alert_rules',
    description:
      'List all notification alert rules. Returns id, name, enabled, type (threshold/event), category (node/container/proxy/certificate/database_postgres/database_clickhouse/database_redis), severity, metric, operator, thresholdValue, eventPattern, resourceIds, webhookIds, cooldownSeconds.',
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
