import { INTERNAL_DOCS } from './ai.docs.js';
import type { AIToolDefinition } from './ai.types.js';

export const CONTROL_AI_TOOLS: AIToolDefinition[] = [
  // ── Maintenance and Control Plane ──
  {
    name: 'get_license_status',
    description: 'Read Gateway license status, tier, installation ID, expiry, grace state, and masked key metadata.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'license:view',
    invalidateStores: [],
  },
  {
    name: 'manage_license',
    description:
      'Manage the Gateway license. operation must be one of activate, check, or clear. activate requires licenseKey.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['activate', 'check', 'clear'],
          description: 'License operation to perform.',
        },
        licenseKey: { type: 'string', description: 'License key for activate.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'license:manage',
    invalidateStores: ['settings'],
  },
  {
    name: 'manage_housekeeping',
    description:
      'Read or manage housekeeping. operation: get_config, get_stats, get_history, update_config, or run. update_config requires config.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get_config', 'get_stats', 'get_history', 'update_config', 'run'],
          description: 'Housekeeping operation to perform.',
        },
        config: { type: 'object', description: 'Partial housekeeping config for update_config.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'housekeeping:view',
    invalidateStores: ['settings'],
  },
  {
    name: 'get_gateway_settings',
    description:
      'Read Gateway control-plane settings: OIDC provisioning, MCP server enablement and compatibility, and general settings including inferenceEnabled, plus network security and outbound webhook policy.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'settings:gateway:view',
    invalidateStores: [],
  },
  {
    name: 'update_gateway_settings',
    description:
      'Update Gateway control-plane settings. Pass only fields to change: OIDC provisioning, MCP server enablement or compatibility, generalSettings, networkSecurity, or outboundWebhookPolicy.',
    parameters: {
      type: 'object',
      properties: {
        oidcAutoCreateUsers: { type: 'boolean' },
        oidcDefaultGroupId: { type: 'string', description: 'Default permission group UUID for auto-created users.' },
        oidcRequireVerifiedEmail: { type: 'boolean' },
        oauthExtendedCallbackCompatibility: { type: 'boolean' },
        mcpServerEnabled: { type: 'boolean' },
        mcpExtendedCompatibility: {
          type: 'boolean',
          description:
            'Return every OAuth-scoped MCP tool in the initial tools/list response. Enabled by default; disable only for harnesses that load every tool schema into context and exhaust it, because they may then be unable to use some Gateway tools.',
        },
        generalSettings: { type: 'object' },
        networkSecurity: { type: 'object' },
        outboundWebhookPolicy: { type: 'object' },
      },
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'settings:gateway:edit',
    invalidateStores: ['settings'],
  },
  {
    name: 'manage_system_updates',
    description:
      'Read or manage Gateway and daemon updates. Operations: get_gateway_status, check_gateway, get_gateway_release_notes, perform_gateway_update, list_daemon_updates, check_daemon_updates, update_daemon. Mutating operations require explicit approval unless the user bypass mode allows it.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'get_gateway_status',
            'check_gateway',
            'get_gateway_release_notes',
            'perform_gateway_update',
            'list_daemon_updates',
            'check_daemon_updates',
            'update_daemon',
          ],
          description: 'System update operation to perform.',
        },
        version: {
          type: 'string',
          description: 'Gateway version for get_gateway_release_notes or perform_gateway_update.',
        },
        nodeId: { type: 'string', description: 'Daemon node UUID for update_daemon.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'admin:update',
    invalidateStores: ['settings', 'nodes'],
  },
  {
    name: 'get_audit_log',
    description: 'Query the audit log. Returns paginated entries with action, user, resource, and timestamp.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Filter by action name' },
        resourceType: { type: 'string', description: 'Filter by resource type' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:audit',
    invalidateStores: [],
  },
  {
    name: 'get_dashboard_stats',
    description:
      'Get dashboard statistics: counts of CAs, certificates, ingress routes, SSL certs, nodes, and expiring items.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  // ── Permission Groups ──
  {
    name: 'list_groups',
    description: 'List all permission groups with their scopes, member counts, and inheritance info.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: [],
  },
  {
    name: 'create_group',
    description: 'Create a new permission group with specific scopes. Can optionally inherit from a parent group.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name (e.g., "cert-operator")' },
        description: { type: 'string', description: 'Optional description' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of scope strings (e.g., ["cert:read", "cert:issue"])',
        },
        parentId: { type: 'string', description: 'Optional parent group UUID to inherit scopes from' },
      },
      required: ['name', 'scopes'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: ['groups'],
  },
  {
    name: 'update_group',
    description: 'Update a permission group. Built-in groups cannot be modified.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group UUID' },
        name: { type: 'string', description: 'New group name' },
        description: { type: 'string', description: 'New description' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'New scopes array (replaces existing)',
        },
        parentId: {
          type: ['string', 'null'],
          description: 'New parent group UUID, or null to remove inheritance',
        },
      },
      required: ['groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: ['groups'],
  },
  {
    name: 'delete_group',
    description: 'Delete a permission group. Cannot delete built-in groups or groups with assigned users.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group UUID to delete' },
      },
      required: ['groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: ['groups'],
  },
  {
    name: 'set_resource_pin',
    description:
      "Set whether a readable resource is pinned to the current browser session's Dashboard or Sidebar. This is a local UI preference, not a server-side resource mutation. Resolve the resource with find_resource first; Docker pins also require nodeId, nodeSlug, and name. This tool is unavailable to MCP clients.",
    parameters: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          enum: ['node', 'proxy_host', 'database', 'docker_container', 'docker_deployment'],
        },
        resourceId: { type: 'string', description: 'Gateway resource ID to pin or unpin.' },
        target: { type: 'string', enum: ['dashboard', 'sidebar'] },
        pinned: { type: 'boolean', description: 'True pins the resource; false removes only this placement.' },
        nodeId: { type: 'string', description: 'Required when resourceType is a Docker container or deployment.' },
        nodeSlug: { type: 'string', description: 'Required when resourceType is a Docker container or deployment.' },
        name: { type: 'string', description: 'Required when resourceType is a Docker container or deployment.' },
        scopeResourceId: { type: 'string', description: 'Optional stable Docker access identity.' },
      },
      required: ['resourceType', 'resourceId', 'target', 'pinned'],
    },
    destructive: false,
    category: 'Dashboard',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'open_node_enrollment',
    description:
      "Open the concrete Gateway node-enrollment flow in the user's current AI Workspace. Use only after the user has chosen to add a Gateway-managed node. This is a client-side setup handoff, not a blocker and not a resource mutation by itself.",
    parameters: {
      type: 'object',
      properties: {},
    },
    destructive: false,
    category: 'Setup',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'open_connector_setup',
    description:
      "Open the concrete add-connector flow in the user's current AI Workspace. Use only after the user has chosen a connector type for a missing prerequisite. Never open the Finalize Setup checklist for this. Use gitlab for a GitLab instance, github for an account-wide GitHub connection, git for a generic Git host, cloudflare for DNS, or ssh for an external server. Include a known generic Git host or repository only when the user already supplied it. This is a client-side setup handoff, not a blocker and not a resource mutation by itself.",
    parameters: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          enum: ['cloudflare', 'gitlab', 'github', 'git', 'ssh'],
          description: 'The connector form to open.',
        },
        baseUrl: {
          type: 'string',
          description: 'Optional known provider or Git-host base URL to prefill.',
        },
        repositoryUrl: {
          type: 'string',
          description: 'Optional known repository URL to prefill for generic Git.',
        },
        host: {
          type: 'string',
          description: 'Optional known external SSH host to prefill.',
        },
      },
      required: ['connector'],
    },
    destructive: false,
    category: 'Setup',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },

  // ── Ask Question ──
  {
    name: 'ask_question',
    description:
      "Ask the user a clarifying question before proceeding. Use this only when a material requirement is unclear, ambiguous, or missing and cannot be inferred from context, tool results, or a standard default. Never use this tool to confirm or approve an action the user already requested; Gateway's approval UI handles policy-required confirmations. Do not ask when there is exactly one valid applicable option or the user asked you to choose automatically/use defaults. You can provide options for the user to pick from, allow free text input, or both.",
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short option label' },
              description: { type: 'string', description: 'Optional longer description' },
            },
            required: ['label'],
          },
          description: 'Optional list of choices for the user to pick from',
        },
        allowFreeText: {
          type: 'boolean',
          description:
            'Whether to also show a free text input (default: true if no options, false if options provided)',
        },
      },
      required: ['question'],
    },
    destructive: false,
    category: 'Interaction',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },

  // ── Internal Documentation ──
  {
    name: 'internal_documentation',
    description:
      'Get detailed internal documentation about a specific topic in this system. Use this whenever you need deeper knowledge about how something works, what fields mean, or what the correct workflow is. Topics: discovery, pki, ssl, proxy, pages, domains, access-lists, templates, acme, users, audit, siem, nginx, nodes, housekeeping, permissions, docker, databases, postgres, redis, logging, folders, node-files, sandbox, conversations, ai-settings, status-page, api, gateway-settings, licensing-updates, inference, gitlab, notifications, overview, installation, authentication, cloudflare, docker-registries, clickhouse, troubleshooting.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: Object.keys(INTERNAL_DOCS),
          description: 'The topic to get documentation about',
        },
      },
      required: ['topic'],
    },
    destructive: false,
    category: 'Documentation',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context', maxBytes: 32000 },
  },
  {
    name: 'read_gateway_documentation',
    description:
      'Read Gateway internal operational documentation through remote MCP. Topic access is filtered by the OAuth token scopes; general MCP workflow topics remain available to every authenticated MCP connection.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: Object.keys(INTERNAL_DOCS),
          description: 'Gateway documentation topic to read.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    destructive: false,
    category: 'Documentation',
    requiredScope: 'mcp:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
    mcpOnly: true,
  },
];
