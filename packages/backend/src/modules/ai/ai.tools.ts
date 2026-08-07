import { DATABASE_AI_TOOLS } from './ai.tools.databases.js';
import { DOCKER_AI_TOOLS } from './ai.tools.docker.js';
import { FOLDER_AI_TOOLS } from './ai.tools.folders.js';
import { GITLAB_AI_TOOLS } from './ai.tools.gitlab.js';
import { INFERENCE_AI_TOOLS } from './ai.tools.inference.js';
import { NODE_FILE_AI_TOOLS } from './ai.tools.node-files.js';
import { NOTIFICATION_AI_TOOLS, WEB_SEARCH_AI_TOOL } from './ai.tools.notifications.js';
import { OPERATION_AI_TOOLS } from './ai.tools.operations.js';
import { PKI_AI_TOOLS } from './ai.tools.pki.js';
import { SANDBOX_AI_TOOLS } from './ai.tools.sandbox.js';
import type { AIToolDefinition } from './ai.types.js';
import { canUseAiTool } from './ai-tool-filtering.js';

export const AI_TOOLS: AIToolDefinition[] = [
  // ── Discovery ──
  {
    name: 'discover_tools',
    description:
      'Discover Gateway tool groups and callable tools before choosing an operation. Use this when you are not sure which tool supports a task, or when a category-specific tool is not visible in your current context.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'Optional Gateway tool category to inspect, for example Docker, Logging, SSL Certificates, Administration, or Reverse Proxy.',
        },
        query: {
          type: 'string',
          description: 'Optional text to filter tool names, descriptions, categories, or required scopes.',
        },
        includeTools: {
          type: 'boolean',
          description:
            'Set true to return matching tool details. When omitted without category/query, only category summaries are returned.',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'get_current_context',
    description:
      'Return the current Gateway page context supplied by the UI: route, focused resource type, and focused resource ID. Use this when the user says "this page", "current resource", or refers to what they are viewing.',
    parameters: {
      type: 'object',
      properties: {},
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'wait',
    description:
      'Wait briefly before continuing. Use this when an operation is still pending or needs time to complete, then call the relevant status/read tool again instead of ending the conversation.',
    parameters: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'Seconds to wait before continuing. Clamped to 1-30 seconds. Default: 5.',
        },
        reason: {
          type: 'string',
          description:
            'Short reason for waiting, for example container startup, image pull, DNS propagation, or log ingestion.',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },
  {
    name: 'send_comment',
    description:
      'Send a short user-visible progress comment during a long multi-tool task, then continue working. Use this proactively before long tool sequences and when instructed that the tool-round limit requires a comment. Call this tool by itself, without other tool calls in the same assistant turn.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            "Concise progress update in the user's language. Mention what you learned or what you are checking next. Do not include secrets.",
        },
      },
      required: ['message'],
    },
    destructive: false,
    category: 'Interaction',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },
  {
    name: 'end_conversation',
    description:
      'End this AI conversation with a localized reason. Use only when the conversation should be closed, for example after repeated unrelated requests or when continuing would be unsafe or outside scope.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short reason shown to the user in their language.',
        },
      },
      required: ['reason'],
    },
    destructive: false,
    category: 'Interaction',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },
  {
    name: 'find_resource',
    description:
      'Global resource search and type-scoped listing. Use this FIRST when the user names a resource but you need its ID, nodeId, or exact type. When the user asks to list resources of a type, pass an empty query with that type, for example { query: "", types: ["docker_container"] }. It searches across readable nodes, Docker containers/images/volumes/networks, proxy hosts, certificates, domains, logging resources, databases, notifications, and more. Do not manually list every node and then scan each node when find_resource can search the resource type directly.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search text, resource name, hostname, domain, ID, image, or key fragment. Use an empty string only when types is provided and you want to list resources of that type.',
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'node',
              'proxy_host',
              'proxy_template',
              'ssl_certificate',
              'domain',
              'access_list',
              'ca',
              'pki_certificate',
              'pki_template',
              'docker_container',
              'docker_deployment',
              'docker_image',
              'docker_volume',
              'docker_network',
              'docker_registry',
              'database',
              'logging_environment',
              'logging_schema',
              'status_page_service',
              'status_page_incident',
              'notification_rule',
              'notification_webhook',
            ],
          },
          description: 'Optional resource types to search. Omit to search all readable resource types.',
        },
        nodeId: { type: 'string', description: 'Optional node UUID to constrain Docker resource searches.' },
        limit: {
          type: 'number',
          description: 'Maximum matches to return across all resource types (default 25, max 50).',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'search_chats',
    description:
      "Search the user's previous AI chats using deterministic raw-history retrieval. Use this when the user refers to prior work, older decisions, previous bugs, commands, errors, files, projects, or missing context. Returns other chats only and excludes the current chat automatically. Returns conversation-level results with message-level snippets; use read_chat_slice for exact source details.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Keep exact identifiers, errors, file paths, commands, and tool names unchanged.',
        },
        scope: {
          type: 'object',
          description:
            'Search boundary. Default is current project when this chat is in a project, otherwise no_project. Use all_user_chats only when the user clearly asks broadly or project-local search is insufficient for an obviously cross-project reference.',
          properties: {
            type: {
              type: 'string',
              enum: ['current_project', 'project', 'no_project', 'all_user_chats'],
            },
            projectId: {
              type: 'string',
              description: 'Required when type is project.',
            },
          },
        },
        limit: { type: 'number', description: 'Maximum conversations to return. Default 10, max 20.' },
      },
      required: ['query'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'find_in_chat',
    description:
      'Search inside a specific previous AI chat without reading the whole chat. Use after search_chats when you know the target conversation but need a more precise matching message.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation UUID to search.' },
        query: { type: 'string', description: 'Search query within that conversation.' },
        limit: { type: 'number', description: 'Maximum matches to return. Default 10, max 20.' },
      },
      required: ['conversationId', 'query'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'read_chat_slice',
    description:
      'Read a bounded slice of raw messages from a previous AI chat for source verification. Do not use this to read entire chat histories; call search_chats or find_in_chat first unless the user named the exact chat.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation UUID to read.' },
        mode: {
          type: 'string',
          enum: ['latest', 'first', 'around_message', 'after', 'before'],
          description: 'Which bounded slice to read.',
        },
        messageId: { type: 'string', description: 'Anchor message UUID for around_message, after, or before.' },
        cursor: { type: 'string', description: 'Cursor returned by a previous read_chat_slice call.' },
        limit: { type: 'number', description: 'Maximum messages to return. Default 20, max 50.' },
      },
      required: ['conversationId', 'mode'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'list_chat_projects',
    description:
      'List AI chat projects as retrieval boundaries. These are saved chat groupings, not GitLab projects. Never use this for GitLab; use gitlab_list_projects instead.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum projects to return. Default 20, max 50.' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous list_chat_projects response.' },
      },
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },

  // ── PKI ──
  ...PKI_AI_TOOLS,

  // ── Folders ──
  ...FOLDER_AI_TOOLS,

  // ── Reverse Proxy ──
  {
    name: 'list_proxy_hosts',
    description: 'List all reverse proxy hosts with their status, domains, and SSL configuration.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by domain name' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:view',
    invalidateStores: [],
  },
  {
    name: 'get_proxy_host',
    description: 'Get detailed configuration of a specific proxy host.',
    parameters: {
      type: 'object',
      properties: {
        proxyHostId: { type: 'string', description: 'Proxy host UUID' },
      },
      required: ['proxyHostId'],
    },
    destructive: false,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:view',
    invalidateStores: [],
  },
  {
    name: 'create_proxy_host',
    description: 'Create a new reverse proxy host configuration.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['proxy', 'redirect', '404'], description: 'Host type (default: proxy)' },
        nodeId: { type: 'string', description: 'Node UUID to deploy this proxy host on (required)' },
        domainNames: { type: 'array', items: { type: 'string' }, description: 'Domain names for this host' },
        forwardHost: { type: 'string', description: 'Backend host to proxy to (for proxy type)' },
        forwardPort: { type: 'number', description: 'Backend port (for proxy type)' },
        forwardScheme: { type: 'string', enum: ['http', 'https'], description: 'Backend scheme (default: http)' },
        sslEnabled: { type: 'boolean', description: 'Enable SSL/TLS' },
        sslForced: { type: 'boolean', description: 'Force HTTPS redirect (default: false)' },
        sslCertificateId: {
          type: 'string',
          description: 'SSL certificate UUID to use (must be from ssl_certificates, not PKI)',
        },
        websocketSupport: { type: 'boolean', description: 'Enable WebSocket proxying' },
        http2Support: { type: 'boolean', description: 'Enable HTTP/2' },
        redirectUrl: { type: 'string', description: 'Redirect target URL (for redirect type)' },
        redirectStatusCode: { type: 'number', enum: [301, 302, 307, 308], description: 'Redirect status code' },
        internalCertificateId: { type: 'string', description: 'Linked internal PKI certificate UUID' },
        customHeaders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
          description: 'Custom HTTP headers to add to proxied requests',
        },
        cacheEnabled: { type: 'boolean', description: 'Enable response caching' },
        cacheOptions: {
          type: 'object',
          properties: {
            maxAge: { type: 'number', description: 'Cache max age in seconds' },
            staleWhileRevalidate: { type: 'number', description: 'Serve stale while revalidating (seconds)' },
          },
          description: 'Cache configuration (requires cacheEnabled)',
        },
        rateLimitEnabled: { type: 'boolean', description: 'Enable per-host rate limiting' },
        rateLimitOptions: {
          type: 'object',
          properties: {
            requestsPerSecond: { type: 'number', description: 'Max requests per second' },
            burst: { type: 'number', description: 'Burst allowance' },
          },
          required: ['requestsPerSecond'],
          description: 'Rate limit configuration (requires rateLimitEnabled)',
        },
        customRewrites: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              destination: { type: 'string' },
              type: { type: 'string', enum: ['permanent', 'temporary'] },
            },
            required: ['source', 'destination', 'type'],
          },
          description: 'URL rewrite rules applied before proxying',
        },
        accessListId: { type: 'string', description: 'Access list UUID for IP/auth restrictions' },
        folderId: { type: 'string', description: 'Folder UUID for organizing this proxy host' },
        nginxTemplateId: { type: 'string', description: 'Custom nginx config template UUID' },
        templateVariables: { type: 'object', description: 'Variables for the nginx template (key-value pairs)' },
        healthCheckEnabled: { type: 'boolean', description: 'Enable backend health checks' },
        healthCheckUrl: { type: 'string', description: 'Health check endpoint path (e.g., /health)' },
        healthCheckInterval: { type: 'number', description: 'Seconds between health checks (5-3600, default: 30)' },
        healthCheckExpectedStatus: { type: 'number', description: 'Expected HTTP status code (100-599)' },
        healthCheckExpectedBody: { type: 'string', description: 'Expected response body string' },
        healthCheckBodyMatchMode: {
          type: 'string',
          enum: ['includes', 'exact', 'starts_with', 'ends_with'],
          description: 'How to match the expected health-check response body',
        },
        healthCheckSlowThreshold: { type: 'number', description: 'Nx average threshold for degraded health checks' },
      },
      required: ['nodeId', 'domainNames'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:create',
    invalidateStores: ['proxy'],
  },
  {
    name: 'update_proxy_host',
    description: 'Update an existing proxy host configuration.',
    parameters: {
      type: 'object',
      properties: {
        proxyHostId: { type: 'string', description: 'Proxy host UUID' },
        type: {
          type: 'string',
          enum: ['proxy', 'redirect', '404'],
          description: 'Host type; raw is handled by raw tools',
        },
        nodeId: { type: 'string', description: 'Node UUID to deploy this proxy host on' },
        domainNames: { type: 'array', items: { type: 'string' }, description: 'Domain names' },
        forwardHost: { type: ['string', 'null'], description: 'Backend host; null clears it' },
        forwardPort: { type: ['number', 'null'], description: 'Backend port; null clears it' },
        forwardScheme: { type: 'string', enum: ['http', 'https'] },
        sslEnabled: { type: 'boolean' },
        sslForced: { type: 'boolean', description: 'Force HTTPS redirect' },
        http2Support: { type: 'boolean', description: 'Enable HTTP/2' },
        websocketSupport: { type: 'boolean', description: 'Enable WebSocket proxying' },
        sslCertificateId: { type: ['string', 'null'], description: 'SSL certificate UUID; null clears it' },
        internalCertificateId: {
          type: ['string', 'null'],
          description: 'Internal PKI certificate UUID; null clears it',
        },
        redirectUrl: { type: ['string', 'null'], description: 'Redirect target URL; null clears it' },
        redirectStatusCode: { type: ['number', 'null'], enum: [301, 302, 307, 308, null] },
        customHeaders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
          description: 'Full replacement list of custom HTTP headers',
        },
        cacheEnabled: { type: 'boolean', description: 'Enable response caching' },
        cacheOptions: {
          type: ['object', 'null'],
          properties: {
            maxAge: { type: 'number' },
            staleWhileRevalidate: { type: 'number' },
          },
          description: 'Cache configuration; null clears it',
        },
        rateLimitEnabled: { type: 'boolean', description: 'Enable rate limiting' },
        rateLimitOptions: {
          type: ['object', 'null'],
          properties: {
            requestsPerSecond: { type: 'number' },
            burst: { type: 'number' },
          },
          description: 'Rate limit configuration; null clears it',
        },
        customRewrites: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              destination: { type: 'string' },
              type: { type: 'string', enum: ['permanent', 'temporary'] },
            },
            required: ['source', 'destination', 'type'],
          },
          description: 'Full replacement list of URL rewrite rules',
        },
        advancedConfig: { type: ['string', 'null'], description: 'Advanced nginx snippet; requires proxy:advanced' },
        accessListId: { type: ['string', 'null'], description: 'Access list UUID; null clears it' },
        folderId: { type: ['string', 'null'], description: 'Folder UUID; null moves to root' },
        nginxTemplateId: { type: ['string', 'null'], description: 'Config template UUID; null uses default' },
        templateVariables: { type: ['object', 'null'], description: 'Template variables; null clears them' },
        healthCheckEnabled: { type: 'boolean', description: 'Enable backend health checks' },
        healthCheckUrl: { type: ['string', 'null'], description: 'Health check endpoint path; null clears it' },
        healthCheckInterval: { type: ['number', 'null'], description: 'Seconds between health checks; null clears it' },
        healthCheckExpectedStatus: { type: ['number', 'null'], description: 'Expected status; null clears it' },
        healthCheckExpectedBody: { type: ['string', 'null'], description: 'Expected body text; null clears it' },
        healthCheckBodyMatchMode: {
          type: ['string', 'null'],
          enum: ['includes', 'exact', 'starts_with', 'ends_with', null],
          description: 'How to match the expected response body; null clears it',
        },
        healthCheckSlowThreshold: { type: ['number', 'null'], description: 'Nx average threshold; null clears it' },
        enabled: { type: 'boolean', description: 'Enable/disable the host' },
      },
      required: ['proxyHostId'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:edit',
    invalidateStores: ['proxy'],
  },
  {
    name: 'delete_proxy_host',
    description: 'Permanently delete a proxy host and its nginx configuration.',
    parameters: {
      type: 'object',
      properties: {
        proxyHostId: { type: 'string', description: 'Proxy host UUID to delete' },
      },
      required: ['proxyHostId'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:delete',
    invalidateStores: ['proxy'],
  },

  // ── Proxy Host Folders ──
  {
    name: 'create_proxy_folder',
    description: 'Create a folder to organize proxy hosts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        parentId: { type: 'string', description: 'Parent folder UUID for nesting (optional)' },
      },
      required: ['name'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:folders:manage',
    invalidateStores: ['proxy'],
  },
  {
    name: 'move_hosts_to_folder',
    description: 'Move one or more proxy hosts into a folder (or to root by passing null as folderId).',
    parameters: {
      type: 'object',
      properties: {
        hostIds: { type: 'array', items: { type: 'string' }, description: 'Proxy host UUIDs to move' },
        folderId: { type: ['string', 'null'], description: 'Target folder UUID, or null to move to root (ungrouped)' },
      },
      required: ['hostIds', 'folderId'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:folders:manage',
    invalidateStores: ['proxy'],
  },
  {
    name: 'delete_proxy_folder',
    description: 'Delete a proxy host folder. Hosts inside will be moved to root (ungrouped).',
    parameters: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder UUID to delete' },
      },
      required: ['folderId'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:folders:manage',
    invalidateStores: ['proxy'],
  },
  {
    name: 'manage_proxy_template',
    description:
      'Manage custom nginx proxy templates. Operations: list, get, create, update, delete, clone. Operation-specific proxy:templates:* scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'clone'] },
        templateId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['proxy', 'redirect', '404'] },
        content: { type: 'string' },
        variables: { type: 'array', items: { type: 'object' } },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:templates:view',
    invalidateStores: ['proxy'],
  },

  // ── SSL Certificates ──
  {
    name: 'list_ssl_certificates',
    description: 'List SSL/TLS certificates (ACME, uploaded, internal). Shows name, type, domains, expiry.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name or domain' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    destructive: false,
    category: 'SSL Certificates',
    requiredScope: 'ssl:cert:view',
    invalidateStores: [],
  },
  {
    name: 'request_acme_cert',
    description:
      "Request a new SSL certificate via ACME (Let's Encrypt). HTTP-01 is fully automatic. For DNS-01, pass dnsProvider: 'cloudflare' when Gateway should create the TXT records through a configured Cloudflare connector and finish issuance automatically; omit dnsProvider for manual DNS-01.",
    parameters: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain names to include in the certificate',
        },
        challengeType: { type: 'string', enum: ['http-01', 'dns-01'], description: 'ACME challenge type' },
        provider: {
          type: 'string',
          enum: ['letsencrypt', 'letsencrypt-staging'],
          description: 'ACME provider (default: letsencrypt)',
        },
        dnsProvider: {
          type: 'string',
          enum: ['cloudflare'],
          description:
            'DNS automation provider for DNS-01. Use cloudflare only when matching Cloudflare zones are synced.',
        },
        autoRenew: {
          type: 'boolean',
          description:
            'Auto-renew before expiry. Defaults true for HTTP-01 and Cloudflare DNS-01; manual DNS-01 cannot auto-renew.',
        },
      },
      required: ['domains', 'challengeType'],
    },
    destructive: true,
    category: 'SSL Certificates',
    requiredScope: 'ssl:cert:issue',
    invalidateStores: ['ssl'],
  },

  {
    name: 'link_internal_cert',
    description:
      'Import a PKI certificate as an SSL certificate so it can be used with proxy hosts. This links an existing PKI certificate (from the Certificates table) into the SSL certificates pool. You MUST use this before assigning a PKI-issued cert to a proxy host.',
    parameters: {
      type: 'object',
      properties: {
        internalCertId: { type: 'string', description: 'The PKI certificate UUID to import as SSL certificate' },
        name: { type: 'string', description: 'Display name for the SSL certificate (optional, defaults to cert CN)' },
      },
      required: ['internalCertId'],
    },
    destructive: true,
    category: 'SSL Certificates',
    requiredScope: 'ssl:cert:issue',
    invalidateStores: ['ssl'],
  },
  {
    name: 'manage_ssl_certificate',
    description:
      'Manage SSL certificates beyond listing/request/link. Operations: get, upload, renew, verify_dns, set_auto_renew, delete. Operation-specific ssl:cert:* scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'upload', 'renew', 'verify_dns', 'set_auto_renew', 'delete'] },
        sslCertificateId: { type: 'string' },
        name: { type: 'string' },
        certificatePem: { type: 'string' },
        privateKeyPem: { type: 'string' },
        chainPem: { type: 'string' },
        enabled: { type: 'boolean', description: 'Enable or disable auto-renewal when operation is set_auto_renew' },
        provider: {
          type: 'string',
          enum: ['cloudflare'],
          description: 'Required when enabling DNS-01 auto-renewal; omitted for HTTP-01 or disabling.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'SSL Certificates',
    requiredScope: 'ssl:cert:view',
    invalidateStores: ['ssl'],
  },

  // ── Domains ──
  {
    name: 'list_domains',
    description: 'List registered domains with their DNS verification status.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by domain name' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    destructive: false,
    category: 'Domains',
    requiredScope: 'domains:view',
    invalidateStores: [],
  },
  {
    name: 'create_domain',
    description:
      'Create a Cloudflare-backed Gateway domain and its A/AAAA DNS records. If Cloudflare already has different A/AAAA records, the tool returns conflict metadata; retry with overwriteDns only after explicit user approval.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (e.g., "example.com")' },
        description: { type: 'string', description: 'Optional description' },
        ttl: { type: 'number', description: 'Optional Cloudflare DNS TTL override' },
        proxied: { type: 'boolean', description: 'Optional Cloudflare proxy override' },
        overwriteDns: {
          type: 'boolean',
          description: 'Replace existing Cloudflare A/AAAA records after explicit user approval',
        },
      },
      required: ['domain'],
    },
    destructive: true,
    category: 'Domains',
    requiredScope: 'integrations:cloudflare:dns:edit',
    invalidateStores: ['domains'],
  },
  {
    name: 'delete_domain',
    description:
      'Remove a Gateway domain. Cloudflare-created/overwritten rows delete their DNS records. For matched-existing rows, pass deleteDns to choose whether to remove Cloudflare DNS or only the Gateway mapping.',
    parameters: {
      type: 'object',
      properties: {
        domainId: { type: 'string', description: 'Domain UUID to delete' },
        deleteDns: {
          type: 'boolean',
          description: 'For matched-existing Cloudflare records, true deletes DNS and false keeps DNS',
        },
      },
      required: ['domainId'],
    },
    destructive: true,
    category: 'Domains',
    requiredScope: 'domains:delete',
    invalidateStores: ['domains'],
  },
  {
    name: 'manage_domain',
    description: 'Get, update, or re-check DNS for a registered domain. Operations: get, update, check_dns.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'update', 'check_dns'] },
        domainId: { type: 'string' },
        description: { type: ['string', 'null'] },
      },
      required: ['operation', 'domainId'],
    },
    destructive: true,
    category: 'Domains',
    requiredScope: 'domains:view',
    invalidateStores: ['domains'],
  },

  // ── Access Lists ──
  {
    name: 'list_access_lists',
    description: 'List IP access control and basic authentication lists.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    destructive: false,
    category: 'Access Lists',
    requiredScope: 'acl:view',
    invalidateStores: [],
  },
  {
    name: 'create_access_list',
    description: 'Create a new access list with IP allow/deny rules and optional basic auth.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Access list name' },
        description: { type: 'string', description: 'Optional description' },
        allowIps: { type: 'array', items: { type: 'string' }, description: 'Allowed IP ranges (CIDR)' },
        denyIps: { type: 'array', items: { type: 'string' }, description: 'Denied IP ranges (CIDR)' },
        basicAuthEnabled: { type: 'boolean', description: 'Enable HTTP basic authentication (default: false)' },
        basicAuthUsers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              password: { type: 'string' },
            },
            required: ['username', 'password'],
          },
          description: 'Basic auth users (requires basicAuthEnabled)',
        },
      },
      required: ['name'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:create',
    invalidateStores: ['accessLists'],
  },
  {
    name: 'delete_access_list',
    description: 'Delete an access list. Proxy hosts using it will no longer have access control.',
    parameters: {
      type: 'object',
      properties: {
        accessListId: { type: 'string', description: 'Access list UUID to delete' },
      },
      required: ['accessListId'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:delete',
    invalidateStores: ['accessLists'],
  },
  {
    name: 'manage_access_list',
    description:
      'Get or update an access list. Operations: get, update. Update accepts name, description, ipRules, basicAuthEnabled, and basicAuthUsers.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'update'] },
        accessListId: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        ipRules: { type: 'array', items: { type: 'object' } },
        basicAuthEnabled: { type: 'boolean' },
        basicAuthUsers: { type: 'array', items: { type: 'object' } },
      },
      required: ['operation', 'accessListId'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:view',
    invalidateStores: ['accessLists'],
  },

  // ── Nodes ──
  {
    name: 'list_nodes',
    description: 'List all daemon nodes with their type, status, and connection info.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by hostname' },
        type: {
          type: 'string',
          enum: ['nginx', 'monitoring', 'docker', 'bastion'],
          description: 'Filter by node type',
        },
        status: { type: 'string', enum: ['pending', 'online', 'offline'], description: 'Filter by status' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: [],
  },
  {
    name: 'get_node',
    description: 'Get detailed information about a specific node including live health, stats, and system info.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: [],
  },
  {
    name: 'execute_node_console_command',
    description:
      'Run a one-shot command on a daemon node console. This is destructive by policy even for read-looking commands. Use command as argv, for example ["sh","-lc","systemctl status nginx --no-pager"]. Clearly dangerous commands are blocked; commands with risky patterns require explicit user approval.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command argv to execute. Use ["sh","-lc","..."] for shell syntax.',
        },
      },
      required: ['nodeId', 'command'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:console',
    invalidateStores: ['nodes'],
  },
  {
    name: 'create_node',
    description:
      'Create a new daemon node and generate an enrollment token. IMPORTANT: The response contains enrollmentToken and gatewayCertSha256 — you MUST display both to the user and include --gateway-cert-sha256 in setup commands (curl/wget). The token is one-time-use and cannot be retrieved again.',
    parameters: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'Node hostname (e.g., "proxy-01.example.com")' },
        type: {
          type: 'string',
          enum: ['nginx', 'monitoring', 'docker', 'bastion'],
          description: 'Node type (default: nginx)',
        },
        displayName: { type: 'string', description: 'Optional display name' },
      },
      required: ['hostname'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:create',
    invalidateStores: ['nodes'],
  },
  {
    name: 'rename_node',
    description: 'Update a node display name.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        displayName: { type: 'string', description: 'New display name' },
      },
      required: ['nodeId', 'displayName'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:rename',
    invalidateStores: ['nodes'],
  },
  {
    name: 'delete_node',
    description: 'Delete a daemon node. The node must have no assigned proxy hosts. Also revokes its mTLS certificate.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID to delete' },
      },
      required: ['nodeId'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:delete',
    invalidateStores: ['nodes'],
  },
  {
    name: 'manage_node_config',
    description:
      'Read, update, or test the global nginx configuration on a node. Operations: read, update, test. read requires nodes:config:view:<nodeId>; update/test require nodes:config:edit:<nodeId>.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['read', 'update', 'test'],
          description: 'Node config operation to perform.',
        },
        nodeId: { type: 'string', description: 'Node UUID' },
        content: { type: 'string', description: 'Full nginx config content for update.' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:config:view',
    invalidateStores: ['nodes'],
  },
  ...NODE_FILE_AI_TOOLS,

  // ── Raw Config ──
  {
    name: 'get_proxy_rendered_config',
    description:
      'Get the rendered nginx configuration for a proxy host. Shows either the template-generated or raw config.',
    parameters: {
      type: 'object',
      properties: {
        proxyHostId: { type: 'string', description: 'Proxy host UUID' },
      },
      required: ['proxyHostId'],
    },
    destructive: false,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:raw:read',
    invalidateStores: [],
  },
  {
    name: 'update_proxy_raw_config',
    description: 'Write raw nginx configuration for a proxy host. Raw mode must be enabled first.',
    parameters: {
      type: 'object',
      properties: {
        proxyHostId: { type: 'string', description: 'Proxy host UUID' },
        rawConfig: { type: 'string', description: 'Raw nginx configuration content' },
      },
      required: ['proxyHostId', 'rawConfig'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:raw:write',
    invalidateStores: ['proxy'],
  },
  {
    name: 'toggle_proxy_raw_mode',
    description:
      'Enable or disable raw config mode on a proxy host. When enabled, template rendering is bypassed and the raw config is used directly.',
    parameters: {
      type: 'object',
      properties: {
        proxyHostId: { type: 'string', description: 'Proxy host UUID' },
        enabled: { type: 'boolean', description: 'true to enable raw mode, false to disable' },
      },
      required: ['proxyHostId', 'enabled'],
    },
    destructive: true,
    category: 'Reverse Proxy',
    requiredScope: 'proxy:raw:toggle',
    invalidateStores: ['proxy'],
  },

  // ── Administration ──
  {
    name: 'list_users',
    description: 'List all users with their roles, email, and last login info.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: [],
  },
  {
    name: 'create_user',
    description:
      'Create a user before first login and assign an initial permission group. You can only assign groups within your own effective scopes.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'User email address' },
        name: { type: 'string', description: 'Optional display name' },
        groupId: { type: 'string', description: 'Initial permission group UUID' },
      },
      required: ['email', 'groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'update_user_role',
    description: "Change a user's permission group. Use list_users to see available groups.",
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        groupId: { type: 'string', description: 'Permission group UUID to assign' },
      },
      required: ['userId', 'groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'set_user_blocked',
    description:
      'Block or unblock a user account. Cannot target yourself, the system user, or users whose scopes exceed yours.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        blocked: { type: 'boolean', description: 'true to block, false to unblock' },
      },
      required: ['userId', 'blocked'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'delete_user',
    description:
      'Soft-delete a user account and revoke access. Cannot target yourself, the system user, or users whose scopes exceed yours. Restoration is available only to system administrators through the Administration UI/API.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
      },
      required: ['userId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },

  // ── AI Assistant Configuration ──
  {
    name: 'get_ai_settings',
    description:
      'Read AI assistant configuration, including provider, limits, disabled tools, web search, and sandbox runner settings. Secrets are returned only as masked metadata.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Assistant',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'update_ai_settings',
    description:
      'Update AI assistant configuration. Only pass fields that should change; API keys may be replaced or cleared with an empty string.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable or disable the AI assistant.' },
        providerType: {
          type: 'string',
          enum: ['openai_compatible', 'gateway_inference'],
          description: 'Assistant response provider.',
        },
        providerUrl: { type: 'string', description: 'OpenAI-compatible provider base URL.' },
        endpointMode: {
          type: 'string',
          enum: ['auto', 'chat_completions', 'responses'],
          description: 'Provider endpoint family.',
        },
        apiKey: { type: 'string', description: 'Provider API key. Empty string clears the saved key.' },
        model: { type: 'string', description: 'Model name.' },
        gatewayInferenceModel: {
          type: 'string',
          description: 'Default published Gateway Inference model ID.',
        },
        gatewayInferenceAllowUserModelSelection: {
          type: 'boolean',
          description: 'Allow users to select another accessible Gateway Inference model.',
        },
        customSystemPrompt: { type: 'string', description: 'Additional system prompt instructions.' },
        rateLimitMax: { type: 'number', description: 'Maximum assistant requests per window.' },
        rateLimitWindowSeconds: { type: 'number', description: 'Rate limit window in seconds.' },
        maxToolRounds: { type: 'number', description: 'Maximum sequential tool calls per assistant response.' },
        maxContextTokens: { type: 'number', description: 'Context token budget.' },
        maxCompletionTokens: { type: 'number', description: 'Maximum generated response tokens.' },
        maxTokensField: {
          type: 'string',
          enum: ['max_tokens', 'max_completion_tokens'],
          description: 'Provider request token field.',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'none'],
          description: 'Reasoning effort setting.',
        },
        disabledTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names disabled for the assistant.',
        },
        webSearchProvider: {
          type: 'string',
          enum: ['tavily', 'brave', 'serper', 'searxng', 'exa'],
          description: 'Web search provider.',
        },
        webSearchBaseUrl: { type: 'string', description: 'Web search provider base URL, used by SearXNG.' },
        webSearchApiKey: { type: 'string', description: 'Web search API key. Empty string clears the saved key.' },
        sandboxEnabled: { type: 'boolean', description: 'Expose sandbox execution tools to the assistant.' },
        sandboxDefaultTier: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Default sandbox resource tier.',
        },
      },
    },
    destructive: true,
    category: 'AI Assistant',
    requiredScope: 'feat:ai:configure',
    invalidateStores: ['settings'],
  },
  {
    name: 'list_ai_tools',
    description:
      'List AI assistant tools with categories, descriptions, scopes, and destructive metadata for configuration or auditing.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Assistant',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'get_sandbox_runtime_status',
    description:
      'Read sandbox runner configuration and runtime health without starting a sandbox job. Use this to diagnose whether sandbox execution is enabled and available.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Assistant',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'manage_ai_conversation',
    description:
      'Manage the current user AI conversations. Operations: list, get, delete, delete_by_title. This tool never creates or rewrites conversation history.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'delete', 'delete_by_title'],
          description: 'Conversation operation to perform.',
        },
        conversationId: { type: 'string', description: 'Conversation UUID for get or delete.' },
        title: { type: 'string', description: 'Conversation title for delete_by_title.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Conversations',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },
  {
    name: 'manage_oauth_authorization',
    description:
      'Manage existing OAuth authorizations for the current user. Operations: list, update_scopes, revoke. Pending browser consent is intentionally not exposed.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'update_scopes', 'revoke'],
          description: 'OAuth authorization operation to perform.',
        },
        clientId: { type: 'string', description: 'OAuth client ID for update_scopes or revoke.' },
        resource: { type: 'string', description: 'OAuth resource URL for update_scopes or revoke.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement delegated scopes for update_scopes.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'OAuth',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },
  {
    name: 'manage_api_token',
    description:
      'Manage Gateway API tokens for the current browser user. Operations: list, create, update, revoke. Token secrets are returned only on create.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'create', 'update', 'revoke'],
          description: 'API token operation to perform.',
        },
        tokenId: { type: 'string', description: 'Token UUID for update or revoke.' },
        name: { type: 'string', description: 'Token name for create or update.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'API token scopes for create or update. Must be a subset of the current user scopes.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Settings',
    requiredScope: 'feat:ai:use',
    invalidateStores: ['settings'],
    historyRetention: { mode: 'never_full' },
  },

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
      'Read Gateway control-plane settings: OIDC provisioning, MCP server enablement and compatibility, and general settings including inferenceEnabled and harnessSpecificEndpointsEnabled, plus network security and outbound webhook policy.',
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
      'Get dashboard statistics: counts of CAs, certificates, proxy hosts, SSL certs, nodes, expiring items.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'feat:ai:use',
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
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },

  // ── Ask Question ──
  {
    name: 'ask_question',
    description:
      'Ask the user a clarifying question before proceeding. Use this only when requirements are unclear, ambiguous, or missing critical details that cannot be inferred from context or tool results. You can provide options for the user to pick from, allow free text input, or both. Do not ask when there is exactly one valid applicable option.',
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
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
  },

  // ── Internal Documentation ──
  {
    name: 'internal_documentation',
    description:
      'Get detailed internal documentation about a specific topic in this system. Use this whenever you need deeper knowledge about how something works, what fields mean, or what the correct workflow is. Topics: discovery, pki, ssl, proxy, domains, access-lists, templates, acme, users, audit, nginx, nodes, housekeeping, permissions, docker, databases, postgres, redis, logging, folders, node-files, sandbox, conversations, ai-settings, status-page, api, gateway-settings, licensing-updates, inference, gitlab, notifications, overview, installation, authentication, cloudflare, docker-registries, clickhouse, troubleshooting.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: [
            'discovery',
            'pki',
            'ssl',
            'proxy',
            'domains',
            'access-lists',
            'templates',
            'acme',
            'users',
            'audit',
            'nginx',
            'nodes',
            'housekeeping',
            'permissions',
            'docker',
            'databases',
            'postgres',
            'redis',
            'logging',
            'folders',
            'node-files',
            'sandbox',
            'conversations',
            'status-page',
            'api',
            'gateway-settings',
            'licensing-updates',
            'inference',
            'ai-settings',
            'gitlab',
            'notifications',
            'overview',
            'installation',
            'authentication',
            'cloudflare',
            'docker-registries',
            'clickhouse',
            'troubleshooting',
          ],
          description: 'The topic to get documentation about',
        },
      },
      required: ['topic'],
    },
    destructive: false,
    category: 'Documentation',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context', maxBytes: 32000 },
  },

  // ── Docker ──
  ...DOCKER_AI_TOOLS,
  // ── Databases ──
  ...DATABASE_AI_TOOLS,

  // ── GitLab Integrations ──
  ...GITLAB_AI_TOOLS,

  // ── Inference ──
  ...INFERENCE_AI_TOOLS,

  // ── Operations ──
  ...OPERATION_AI_TOOLS,

  // ── Sandbox ──
  ...SANDBOX_AI_TOOLS,

  // ── Notifications ──
  ...NOTIFICATION_AI_TOOLS,

  // ── Web Search (conditional) ──
  WEB_SEARCH_AI_TOOL,
];

const destructiveSet = new Set(AI_TOOLS.filter((t) => t.destructive).map((t) => t.name));
const BASE_AI_TOOL_NAMES = new Set([
  'discover_tools',
  'get_current_context',
  'wait',
  'send_comment',
  'end_conversation',
  'find_resource',
  'ask_question',
  'internal_documentation',
  'search_chats',
  'find_in_chat',
  'read_chat_slice',
  'list_chat_projects',
  'fetch',
  'web_search',
]);

const TOOL_NAME_BOUNDARY = '[^a-zA-Z0-9_]';

export function isDestructiveTool(name: string): boolean {
  return destructiveSet.has(name);
}

export function inferDiscoveredToolsetsFromText(text: string): string[] {
  const discovered = new Set<string>();
  for (const tool of AI_TOOLS) {
    if (BASE_AI_TOOL_NAMES.has(tool.name)) continue;
    if (matchesToolName(text, tool.name)) discovered.add(tool.category);
  }
  return [...discovered].sort((a, b) => a.localeCompare(b));
}

function matchesToolName(text: string, toolName: string): boolean {
  const escapedName = escapeRegExp(toolName);
  if (new RegExp(`(^|${TOOL_NAME_BOUNDARY})${escapedName}($|${TOOL_NAME_BOUNDARY})`, 'i').test(text)) return true;

  const readableName = escapeRegExp(toolName.replaceAll('_', ' '));
  return new RegExp(`(^|${TOOL_NAME_BOUNDARY})${readableName}($|${TOOL_NAME_BOUNDARY})`, 'i').test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Map of tool names to frontend store names that should be invalidated after execution.
 */
export const TOOL_STORE_INVALIDATION_MAP: Record<string, string[]> = Object.fromEntries(
  AI_TOOLS.filter((t) => t.invalidateStores.length > 0).map((t) => [t.name, t.invalidateStores])
);

/**
 * Get tools in OpenAI function-calling format, filtered by:
 * - Disabled tools (admin config)
 * - User scopes (only tools the user has the required scope for)
 * - Web search availability
 */
export function getOpenAITools(
  disabledTools: string[],
  userScopes: string[],
  webSearchEnabled: boolean,
  options: { discoveredToolsets?: string[]; sandboxEnabled?: boolean } = {}
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  const discoveredToolsets = options.discoveredToolsets === undefined ? undefined : new Set(options.discoveredToolsets);
  return AI_TOOLS.filter((t) => {
    if (disabledTools.includes(t.name)) return false;
    if (t.name === 'web_search' && !webSearchEnabled) return false;
    if (t.category === 'Sandbox' && options.sandboxEnabled !== true) return false;
    if (discoveredToolsets && !BASE_AI_TOOL_NAMES.has(t.name) && !discoveredToolsets.has(t.category)) return false;
    // Every tool must have a requiredScope — reject tools without one
    if (!t.requiredScope) return false;
    return canUseAiTool(t.name, t.requiredScope, userScopes);
  }).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
