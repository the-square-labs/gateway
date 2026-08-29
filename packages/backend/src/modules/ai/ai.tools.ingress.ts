import type { AIToolDefinition } from './ai.types.js';

export const INGRESS_AI_TOOLS: AIToolDefinition[] = [
  // ── Ingress Routes ──
  {
    name: 'list_routes',
    description: 'List all ingress routes with their status, domains, node placement, and TLS configuration.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by domain name' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'Ingress',
    requiredScope: 'proxy:view',
    invalidateStores: [],
  },
  {
    name: 'get_route',
    description: 'Get detailed configuration of a specific ingress route.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
      },
      required: ['routeId'],
    },
    destructive: false,
    category: 'Ingress',
    requiredScope: 'proxy:view',
    invalidateStores: [],
  },
  {
    name: 'create_route',
    description: 'Create a new ingress route configuration on a selected nginx node.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['proxy', 'redirect', '404'], description: 'Host type (default: proxy)' },
        nodeId: { type: 'string', description: 'Nginx ingress node UUID to deploy this route on (required)' },
        domainNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain names for this route; registered domains must use the same nginx node',
        },
        upstreamKind: {
          type: 'string',
          enum: ['manual', 'docker_container', 'docker_deployment', 'pages'],
          description: 'Upstream target kind. Defaults to manual.',
        },
        forwardHost: { type: 'string', description: 'Backend host to proxy to (for proxy type)' },
        forwardPort: { type: 'number', description: 'Backend port (for proxy type)' },
        forwardScheme: { type: 'string', enum: ['http', 'https'], description: 'Backend scheme (default: http)' },
        upstreamIpv6Enabled: {
          type: 'boolean',
          description: 'Allow IPv6 DNS answers and connections for the primary upstream (default: false)',
        },
        dockerNodeId: { type: 'string', description: 'Docker node UUID for a container upstream.' },
        dockerContainerName: { type: 'string', description: 'Stable Docker container name.' },
        dockerComposeProjectId: { type: 'string', description: 'Compose Project UUID for a service upstream.' },
        dockerComposeServiceName: { type: 'string', description: 'Compose service name within the project.' },
        dockerDeploymentId: { type: 'string', description: 'Docker deployment UUID.' },
        dockerContainerPort: { type: 'number', description: 'Published TCP container port.' },
        pageProjectId: { type: 'string', description: 'Page Project UUID for a Pages upstream.' },
        pageTagId: { type: 'string', description: 'Mutable Page Tag UUID for a Pages upstream.' },
        relaySpreadMode: { type: 'string', enum: ['inherit', 'fixed', 'all'] },
        relaySpreadCount: { type: ['number', 'null'], description: 'Required only for fixed relay spread.' },
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
        rateLimitMode: { type: 'string', enum: ['inherit', 'custom', 'disabled'] },
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
        advancedConfig: { type: 'string', description: 'Advanced nginx snippet; requires proxy:advanced.' },
        accessListId: { type: 'string', description: 'Access list UUID for IP/auth restrictions' },
        folderId: { type: 'string', description: 'Folder UUID for organizing this route' },
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
    category: 'Ingress',
    requiredScope: 'proxy:create',
    invalidateStores: ['proxy'],
  },
  {
    name: 'update_route',
    description: 'Update an existing ingress route configuration.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
        type: {
          type: 'string',
          enum: ['proxy', 'redirect', '404'],
          description: 'Host type; raw is handled by raw tools',
        },
        nodeId: { type: 'string', description: 'Nginx ingress node UUID to deploy this route on' },
        domainNames: { type: 'array', items: { type: 'string' }, description: 'Domain names' },
        upstreamKind: {
          type: 'string',
          enum: ['manual', 'docker_container', 'docker_deployment', 'pages'],
          description: 'Managed upstream kind. Pages Routes can be retargeted but not converted to another kind.',
        },
        forwardHost: { type: ['string', 'null'], description: 'Backend host; null clears it' },
        forwardPort: { type: ['number', 'null'], description: 'Backend port; null clears it' },
        forwardScheme: { type: 'string', enum: ['http', 'https'] },
        upstreamIpv6Enabled: {
          type: 'boolean',
          description: 'Allow IPv6 DNS answers and connections for the primary upstream',
        },
        dockerNodeId: { type: ['string', 'null'] },
        dockerContainerName: { type: ['string', 'null'] },
        dockerDeploymentId: { type: ['string', 'null'] },
        dockerContainerPort: { type: ['number', 'null'] },
        pageProjectId: { type: ['string', 'null'] },
        pageTagId: { type: ['string', 'null'] },
        relaySpreadMode: { type: 'string', enum: ['inherit', 'fixed', 'all'] },
        relaySpreadCount: { type: ['number', 'null'] },
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
        rateLimitMode: { type: 'string', enum: ['inherit', 'custom', 'disabled'] },
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
        enabled: { type: 'boolean', description: 'Enable or disable the route' },
      },
      required: ['routeId'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:edit',
    invalidateStores: ['proxy'],
  },
  {
    name: 'set_route_maintenance',
    description:
      'Enter or exit maintenance mode for an enabled managed Route through the canonical maintenance lifecycle.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
        enabled: { type: 'boolean', description: 'True enters maintenance; false exits maintenance.' },
      },
      required: ['routeId', 'enabled'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:edit',
    invalidateStores: ['proxy'],
  },
  {
    name: 'delete_route',
    description: 'Permanently delete an ingress route and its nginx configuration.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID to delete' },
      },
      required: ['routeId'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:delete',
    invalidateStores: ['proxy'],
  },

  // ── Route Folders ──
  {
    name: 'create_route_folder',
    description: 'Create a folder to organize ingress routes.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        parentId: { type: 'string', description: 'Parent folder UUID for nesting (optional)' },
      },
      required: ['name'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:folders:manage',
    invalidateStores: ['proxy'],
  },
  {
    name: 'move_routes_to_folder',
    description: 'Move one or more ingress routes into a folder (or to root by passing null as folderId).',
    parameters: {
      type: 'object',
      properties: {
        routeIds: { type: 'array', items: { type: 'string' }, description: 'Route UUIDs to move' },
        folderId: { type: ['string', 'null'], description: 'Target folder UUID, or null to move to root (ungrouped)' },
      },
      required: ['routeIds', 'folderId'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:folders:manage',
    invalidateStores: ['proxy'],
  },
  {
    name: 'delete_route_folder',
    description: 'Delete a route folder. Routes inside will be moved to root (ungrouped).',
    parameters: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder UUID to delete' },
      },
      required: ['folderId'],
    },
    destructive: true,
    category: 'Ingress',
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
    category: 'Ingress',
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
      'Import a PKI certificate as an SSL certificate so it can be used with ingress routes. This links an existing PKI certificate (from the Certificates table) into the SSL certificates pool. You MUST use this before assigning a PKI-issued cert to a route.',
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
      'Create a Cloudflare-backed Gateway domain on an eligible Nginx ingress node. If Cloudflare already has different A/AAAA records, the tool returns conflict metadata; retry with overwriteDns only after explicit user approval.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (e.g., "example.com")' },
        description: { type: 'string', description: 'Optional description' },
        ttl: { type: 'number', description: 'Optional Cloudflare DNS TTL override' },
        proxied: { type: 'boolean', description: 'Optional Cloudflare proxy override' },
        nginxNodeId: {
          type: 'string',
          description: 'Eligible Nginx node UUID; optional only when exactly one eligible node exists',
        },
        overwriteDns: {
          type: 'boolean',
          description: 'Replace existing Cloudflare A/AAAA records after explicit user approval',
        },
      },
      required: ['domain'],
    },
    destructive: true,
    category: 'Domains',
    requiredScope: 'domains:create',
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
    description: 'Delete an access list. Routes using it will no longer have access control.',
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
];
