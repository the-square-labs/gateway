import { count, eq, inArray } from 'drizzle-orm';
import Handlebars from 'handlebars';
import type { DrizzleClient } from '@/db/client.js';
import { nginxTemplates } from '@/db/schema/nginx-templates.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import {
  escapeNginxReturnText,
  GATEWAY_MAINTENANCE_HTML,
  GATEWAY_NOT_FOUND_HTML,
  gatewayMaintenanceHtml,
  gatewayNotFoundHtml,
} from '@/lib/gateway-error-pages.js';
import { createChildLogger } from '@/lib/logger.js';
import { formatHostPort } from '@/lib/network-endpoint.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { injectAccessListIntoAdvancedLocations } from '@/services/nginx-advanced-location.js';
import type { ProxyAdditionalRouteConfig, ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import type { CreateNginxTemplateInput, UpdateNginxTemplateInput } from './nginx-template.schemas.js';

const logger = createChildLogger('NginxTemplateService');

const NGINX_LOGS_PREFIX = '/var/log/nginx';
const DEFAULT_RATE_LIMIT_RPS = 1000;
const DEFAULT_RATE_LIMIT_BURST = 3000;
const DEFAULT_CONNECTIONS_PER_IP = 1000;

const DEFAULT_PROXY_TEMPLATE_VARIABLES = [
  {
    name: 'cacheEnabled',
    type: 'boolean' as const,
    default: false,
    description: 'Cache upstream responses',
  },
  {
    name: 'cacheMaxAge',
    type: 'number' as const,
    default: 3600,
    description: 'Cache lifetime in seconds',
  },
  {
    name: 'rateLimitMode',
    type: 'string' as const,
    default: 'inherit',
    description: 'Use the gateway default, a custom policy, or disable protection',
  },
  {
    name: 'rateLimitRPS',
    type: 'number' as const,
    default: DEFAULT_RATE_LIMIT_RPS,
    description: 'Requests allowed per second for each client IP',
  },
  {
    name: 'rateLimitBurst',
    type: 'number' as const,
    default: DEFAULT_RATE_LIMIT_BURST,
    description: 'Additional request burst allowed for each client IP',
  },
  {
    name: 'connectionsPerIp',
    type: 'number' as const,
    default: DEFAULT_CONNECTIONS_PER_IP,
    description: 'Concurrent connections allowed for each client IP',
  },
];

// ---------------------------------------------------------------------------
// Register Handlebars helpers
// ---------------------------------------------------------------------------

const DANGEROUS_CHARS = /[\n\r;'"{}`$#]/g;

Handlebars.registerHelper('sanitize', (value: unknown) => {
  if (typeof value !== 'string') return value;
  return new Handlebars.SafeString(value.replace(DANGEROUS_CHARS, ''));
});

Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

Handlebars.registerHelper('indent', (value: unknown, spaces: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  const pad = ' '.repeat(typeof spaces === 'number' ? spaces : 4);
  return new Handlebars.SafeString(
    value
      .split('\n')
      .map((line, i) => (i === 0 ? line : pad + line))
      .join('\n')
  );
});

Handlebars.registerHelper('applyAccessListToAdvancedLocations', (advancedConfig: unknown, accessList: unknown) => {
  if (typeof advancedConfig !== 'string') return '';
  return injectAccessListIntoAdvancedLocations(
    advancedConfig,
    buildAccessListDirectives(accessList as ProxyHostConfig['accessList'])
  );
});

function routeNginxValue(value: string): string {
  return value.replace(DANGEROUS_CHARS, '');
}

function routeRegexPath(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderAdditionalRouteLocation(
  route: ProxyAdditionalRouteConfig,
  hostId: string,
  accessList: ProxyHostConfig['accessList'],
  rateLimitEnabled: boolean,
  rateLimitBurst: number,
  connectionsPerIp: number
): string {
  const path = routeNginxValue(route.path);
  const upstreamName = `gateway_additional_secure_link_${route.id.replace(/-/g, '_')}`;
  const upstream = route.secureLinkUpstream
    ? `${route.forwardScheme}://${upstreamName}`
    : `${route.forwardScheme}://${routeNginxValue(route.forwardHost ?? '')}:${route.forwardPort ?? 0}`;
  const access = buildAccessListDirectives(accessList).map((directive) => `        ${directive}`);
  const limits = rateLimitEnabled
    ? [
        '        limit_req_status 429;',
        `        limit_req zone=ratelimit_${hostId} burst=${rateLimitBurst} nodelay;`,
        '        limit_conn_status 429;',
        `        limit_conn connlimit_${hostId} ${connectionsPerIp};`,
      ]
    : [];
  const common = [...access, ...(access.length > 0 ? [''] : []), ...limits, ...(limits.length > 0 ? [''] : [])];
  const advanced = route.advancedConfig
    ? route.advancedConfig.split(/\r?\n/).map((line) => `        ${line}`)
    : [];
  if (route.targetKind === 'pages') {
    const scopedConfigPath = `${path}/_gateway/pages/config.js`;
    const escaped = routeRegexPath(path);
    const pageBody = [
      ...common,
      '        limit_except GET HEAD { deny all; }',
      '        add_header X-Content-Type-Options nosniff always;',
      '        add_header Referrer-Policy same-origin always;',
      `        rewrite ^${escaped}(?:/(.*))?$ /$1 break;`,
      `        include ${routeNginxValue(route.pagesRouteIncludePath ?? '')};`,
      ...advanced,
      '        try_files $uri $uri/ =404;',
      '        sub_filter_once on;',
      `        sub_filter '</head>' '<script src="${scopedConfigPath}"></script></head>';`,
    ];
    const configLocation = [
      `    location = ${scopedConfigPath} {`,
      ...common,
      '        limit_except GET HEAD { deny all; }',
      `        alias ${routeNginxValue(route.pagesRuntimeConfigPath ?? '')};`,
      '        default_type application/javascript;',
      '        add_header Cache-Control "no-store" always;',
      '    }',
    ];
    return [
      `    location = ${path} {`,
      ...common,
      `        return 308 ${path}/;`,
      '    }',
      '',
      ...configLocation,
      '',
      // Keep this a normal prefix so the following dot-file regex can win;
      // `^~` would suppress regex locations and allow hidden files through.
      `    location ${path}/ {`,
      ...pageBody,
      '    }',
      '',
      `    location ~ ^${escaped}/\\. { deny all; }`,
    ].join('\n');
  }

  const body = [
    ...common,
    route.requestBuffering ? '        proxy_request_buffering on;' : '        proxy_request_buffering off;',
    route.responseBuffering ? '        proxy_buffering on;' : '        proxy_buffering off;',
    `        proxy_connect_timeout ${route.connectTimeoutSeconds}s;`,
    `        proxy_read_timeout ${route.readTimeoutSeconds}s;`,
    `        proxy_send_timeout ${route.sendTimeoutSeconds}s;`,
    ...advanced,
    ...(route.websocketSupport
      ? [
          '        proxy_http_version 1.1;',
          '        proxy_set_header Upgrade $http_upgrade;',
          '        proxy_set_header Connection "upgrade";',
        ]
      : ['        proxy_http_version 1.1;', '        proxy_set_header Connection "";']),
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header X-Forwarded-Host $host;',
    '        proxy_set_header X-Forwarded-Port $server_port;',
    `        proxy_pass ${upstream}${route.stripPrefix ? '/' : ''};`,
  ];
  const exact = [`    location = ${path} {`, ...body, '    }'];
  const prefix = [`    location ^~ ${path}/ {`, ...body, '    }'];
  return [...exact, '', ...prefix].join('\n');
}

Handlebars.registerHelper(
  'renderAdditionalRoutes',
  (
    routes: unknown,
    hostId: unknown,
    accessList: unknown,
    rateLimitEnabled: unknown,
    rateLimitBurst: unknown,
    connectionsPerIp: unknown
  ) => {
    if (!Array.isArray(routes) || routes.length === 0) return '';
    const rendered = routes
      .filter((route): route is ProxyAdditionalRouteConfig => Boolean(route && typeof route === 'object'))
      .sort((left, right) => right.path.length - left.path.length || left.path.localeCompare(right.path))
      .map((route) =>
        renderAdditionalRouteLocation(
          route,
          typeof hostId === 'string' ? hostId : '00000000-0000-0000-0000-000000000000',
          accessList as ProxyHostConfig['accessList'],
          rateLimitEnabled === true,
          typeof rateLimitBurst === 'number' ? rateLimitBurst : DEFAULT_RATE_LIMIT_BURST,
          typeof connectionsPerIp === 'number' ? connectionsPerIp : DEFAULT_CONNECTIONS_PER_IP
        )
      );
    return new Handlebars.SafeString(rendered.join('\n\n'));
  }
);

function buildAccessListDirectives(accessList: ProxyHostConfig['accessList']): string[] {
  if (!accessList) return [];

  const directives = accessList.ipRules.map(
    (rule) => `${rule.type.replace(DANGEROUS_CHARS, '')} ${rule.value.replace(DANGEROUS_CHARS, '')};`
  );
  if (accessList.ipRules.length > 0) directives.push('deny all;');
  if (accessList.basicAuthEnabled) {
    directives.push('auth_basic "Restricted Access";');
    directives.push(
      `auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-${accessList.id.replace(DANGEROUS_CHARS, '')};`
    );
  }
  return directives;
}

// ---------------------------------------------------------------------------
// Built-in template content
// ---------------------------------------------------------------------------

const BUILTIN_PROXY_TEMPLATE = `{{#if rateLimitEnabled}}
limit_req_zone $binary_remote_addr zone=ratelimit_{{id}}:10m rate={{rateLimitRPS}}r/s;
limit_conn_zone $binary_remote_addr zone=connlimit_{{id}}:10m;

{{/if}}
{{#if secureLinkUpstream}}
upstream {{secureLinkUpstreamName}} {
    server unix:{{secureLinkSocketPath}};
    keepalive 64;
}

{{/if}}
{{#if cacheEnabled}}
proxy_cache_path /tmp/nginx-cache-{{id}} levels=1:2 keys_zone=cache_{{id}}:10m max_size=100m inactive={{cacheMaxAge}}s;

{{/if}}
{{#if sslForced}}
server {
    listen 80;
    listen [::]:80;
    server_name {{serverNames}};

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/;
        auth_basic off;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

{{/if}}
server {
{{#unless sslForced}}
    listen 80;
    listen [::]:80;
{{/unless}}
{{#if sslEnabled}}
    listen 443 ssl;
    listen [::]:443 ssl;
{{#if http2Support}}
    http2 on;
{{/if}}
{{/if}}
    server_name {{serverNames}};

{{#if sslEnabled}}
    ssl_certificate {{sslCertPath}};
    ssl_certificate_key {{sslKeyPath}};
{{#if sslChainPath}}
    ssl_trusted_certificate {{sslChainPath}};
{{/if}}

{{/if}}
    access_log {{logPath}}.access.log;
    error_log {{logPath}}.error.log warn;

{{#unless sslForced}}
    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/;
        auth_basic off;
    }

{{/unless}}
{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}
{{#if pagesRouteIncludePath}}
    include {{pagesRouteIncludePath}};
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
    location ~ /\\. { deny all; }

    location = /_gateway/pages/config.js {
{{#if accessList}}
{{#each accessList.ipRules}}
        {{sanitize this.type}} {{sanitize this.value}};
{{/each}}
{{#if accessListHasIpRules}}
        deny all;
{{/if}}
{{#if accessList.basicAuthEnabled}}
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-{{accessList.id}};
{{/if}}

{{/if}}
{{#if rateLimitEnabled}}
        limit_req_status 429;
        limit_req zone=ratelimit_{{id}} burst={{rateLimitBurst}} nodelay;
        limit_conn_status 429;
        limit_conn connlimit_{{id}} {{connectionsPerIp}};
{{/if}}
        limit_except GET HEAD { deny all; }
        alias $gateway_pages_runtime_config_path;
        default_type application/javascript;
        add_header Cache-Control "no-store" always;
{{#each customHeaders}}
        add_header {{sanitize this.name}} "{{sanitize this.value}}" always;
{{/each}}
    }

{{/if}}
    location / {
{{#if accessList}}
{{#each accessList.ipRules}}
        {{sanitize this.type}} {{sanitize this.value}};
{{/each}}
{{#if accessListHasIpRules}}
        deny all;
{{/if}}
{{#if accessList.basicAuthEnabled}}
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-{{accessList.id}};
{{/if}}

{{/if}}
{{#if rateLimitEnabled}}
        limit_req_status 429;
        limit_req zone=ratelimit_{{id}} burst={{rateLimitBurst}} nodelay;
        limit_conn_status 429;
        limit_conn connlimit_{{id}} {{connectionsPerIp}};
{{/if}}
{{#if cacheEnabled}}
{{#if pagesRouteIncludePath}}
        expires {{cacheMaxAge}}s;
        add_header Cache-Control "public, max-age={{cacheMaxAge}}" always;
{{else}}
        proxy_cache cache_{{id}};
        proxy_cache_valid 200 301 302 {{cacheMaxAge}}s;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        add_header X-Cache-Status $upstream_cache_status;
{{/if}}
{{/if}}
{{#if pagesRouteIncludePath}}
        limit_except GET HEAD { deny all; }
        sub_filter_once on;
        sub_filter '</head>' '<script src="/_gateway/pages/config.js"></script></head>';
        try_files $uri $uri/ =404;
{{else}}
{{#if secureLinkUpstream}}
        # gateway-managed-secure-link-upstream {{id}}
{{/if}}
        proxy_pass {{upstream}};

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
{{#if secureLinkUpstream}}
{{#unless websocketSupport}}
        proxy_http_version 1.1;
        proxy_set_header Connection "";
{{/unless}}
{{/if}}

        proxy_connect_timeout 60s;
        proxy_send_timeout {{#if secureLinkUpstream}}2h{{else}}60s{{/if}};
        proxy_read_timeout {{#if secureLinkUpstream}}2h{{else}}60s{{/if}};

{{#if websocketSupport}}
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

{{/if}}
{{/if}}
{{#each customHeaders}}
{{#if ../pagesRouteIncludePath}}
        add_header {{sanitize this.name}} "{{sanitize this.value}}" always;
{{else}}
        proxy_set_header {{sanitize this.name}} "{{sanitize this.value}}";
{{/if}}
{{/each}}
{{#each customRewrites}}
        rewrite {{sanitize this.source}} {{sanitize this.destination}} {{#if (eq this.type "permanent")}}permanent{{else}}redirect{{/if}};
{{/each}}
    }

{{#if advancedConfig}}
    {{{indent (applyAccessListToAdvancedLocations advancedConfig accessList) 4}}}
{{/if}}
}
`;

const BUILTIN_REDIRECT_TEMPLATE = `server {
    listen 80;
    listen [::]:80;
    server_name {{serverNames}};

    access_log {{logPath}}.access.log;
    error_log {{logPath}}.error.log warn;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/;
        auth_basic off;
    }

{{#if sslForced}}
    location / {
        return 301 https://$host$request_uri;
    }
{{else}}
    location / {
        return {{redirectStatusCode}} {{sanitize redirectUrl}};
    }
{{/if}}
}
{{#if sslEnabled}}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
{{#if http2Support}}
    http2 on;
{{/if}}
    server_name {{serverNames}};

{{#if sslCertPath}}
    ssl_certificate {{sslCertPath}};
{{/if}}
{{#if sslKeyPath}}
    ssl_certificate_key {{sslKeyPath}};
{{/if}}
{{#if sslChainPath}}
    ssl_trusted_certificate {{sslChainPath}};
{{/if}}

    access_log {{logPath}}.access.log;
    error_log {{logPath}}.error.log warn;

    location / {
        return {{redirectStatusCode}} {{sanitize redirectUrl}};
    }
}
{{/if}}
`;

const BUILTIN_DEAD_TEMPLATE = `server {
    listen 80;
    listen [::]:80;
    server_name {{serverNames}};

    access_log {{logPath}}.access.log;
    error_log {{logPath}}.error.log warn;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/;
        auth_basic off;
    }

    location / {
        default_type text/html;
        return 404 ${escapeNginxReturnText(GATEWAY_NOT_FOUND_HTML)};
    }
}
{{#if sslEnabled}}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
{{#if http2Support}}
    http2 on;
{{/if}}
    server_name {{serverNames}};

{{#if sslCertPath}}
    ssl_certificate {{sslCertPath}};
{{/if}}
{{#if sslKeyPath}}
    ssl_certificate_key {{sslKeyPath}};
{{/if}}
{{#if sslChainPath}}
    ssl_trusted_certificate {{sslChainPath}};
{{/if}}

    access_log {{logPath}}.access.log;
    error_log {{logPath}}.error.log warn;

    location / {
        default_type text/html;
        return 404 ${escapeNginxReturnText(GATEWAY_NOT_FOUND_HTML)};
    }
}
{{/if}}
`;

function maintenanceAccessVariable(hostId: string) {
  return hostId.replace(/-/g, '_');
}

function maintenanceMaps(hostId: string) {
  const suffix = maintenanceAccessVariable(hostId);
  return `map "$uri:$secure_link" $gm_block_${suffix} {
    default 1;
    ~^/\\.well-known/acme-challenge/ 0;
    ~^/_gateway/maintenance-access: 0;
    ~^/_gateway/maintenance-access/status: 0;
    ~:1$ 0;
}

map $secure_link $gm_active_${suffix} {
    default false;
    "1" true;
}

map $http_cookie $gms_${suffix} {
    default $http_cookie;
    "~^(.*)(?:^|;\\s*)gateway_maintenance_access_sig=[^;]*(;.*)?$" "$1$2";
}

map $gms_${suffix} $gm_cookie_${suffix} {
    default $gms_${suffix};
    "~^(.*)(?:^|;\\s*)gateway_maintenance_access_exp=[^;]*(;.*)?$" "$1$2";
}
`;
}

function maintenanceAccessLocation(hostId: string) {
  const suffix = maintenanceAccessVariable(hostId);
  return `
    location = /_gateway/maintenance-access {
        proxy_pass http://unix:/run/nginx-daemon/maintenance-access.sock:/redeem/${hostId};
        proxy_set_header Host $host;
        proxy_set_header X-Gateway-Maintenance-Host $host;
        proxy_set_header X-Gateway-Maintenance-Secure $https;
        proxy_set_header Cookie "";
        proxy_connect_timeout 5s;
        proxy_send_timeout 5s;
        proxy_read_timeout 5s;
    }

    location = /_gateway/maintenance-access/status {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
        if ($request_method != GET) {
            return 405;
        }
        return 200 '{"active":$gm_active_${suffix}}';
    }
`;
}

function maintenanceServerGuard(hostId: string, accessSecret: string, hideExternalBranding: boolean) {
  const suffix = maintenanceAccessVariable(hostId);
  return `
    # Gateway maintenance mode. Server-rewrite directives run before location
    # selection, so upstream/access/cache/rewrite behavior is never reached.
    default_type text/html;
    add_header Cache-Control "no-store" always;
    secure_link "$cookie_gateway_maintenance_access_sig,$cookie_gateway_maintenance_access_exp";
    secure_link_md5 "\${secure_link_expires}\${host}${accessSecret}";
    if ($gm_block_${suffix}) {
        return 503 ${escapeNginxReturnText(gatewayMaintenanceHtml(hideExternalBranding))};
    }
${maintenanceAccessLocation(hostId)}`;
}

const LEGACY_MAINTENANCE_SERVER_GUARD = `
    # Gateway maintenance mode. Server-rewrite directives run before location
    # selection, so upstream/access/cache/rewrite behavior is never reached.
    default_type text/html;
    add_header Cache-Control "no-store" always;
    if ($uri !~ ^/\\.well-known/acme-challenge/) {
        return 503 ${escapeNginxReturnText(GATEWAY_MAINTENANCE_HTML)};
    }
`;

const BUILTIN_TEMPLATES = [
  {
    name: 'Default Proxy',
    description: 'Standard reverse proxy with SSL, caching, rate limiting, WebSocket, and access control support.',
    type: 'proxy' as const,
    content: BUILTIN_PROXY_TEMPLATE,
    variables: DEFAULT_PROXY_TEMPLATE_VARIABLES,
  },
  {
    name: 'Default Redirect',
    description: 'HTTP redirect with optional SSL termination.',
    type: 'redirect' as const,
    content: BUILTIN_REDIRECT_TEMPLATE,
    variables: [],
  },
  {
    name: 'Default 404',
    description: 'Returns 404 for all requests. Use to block domains.',
    type: '404' as const,
    content: BUILTIN_DEAD_TEMPLATE,
    variables: [],
  },
];

// ---------------------------------------------------------------------------
// Sample context for preview
// ---------------------------------------------------------------------------

const SAMPLE_CONTEXT = {
  id: '00000000-0000-0000-0000-000000000000',
  serverNames: 'example.com www.example.com',
  upstream: 'http://10.0.0.1:8080',
  forwardScheme: 'http',
  forwardHost: '10.0.0.1',
  forwardPort: 8080,
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: false,
  sslCertPath: '/etc/nginx/certs/example.com.crt',
  sslKeyPath: '/etc/nginx/certs/example.com.key',
  sslChainPath: null,
  redirectUrl: 'https://example.com',
  redirectStatusCode: 301,
  cacheEnabled: false,
  cacheMaxAge: 3600,
  cacheStale: 60,
  rateLimitMode: 'inherit',
  rateLimitEnabled: true,
  rateLimitRPS: DEFAULT_RATE_LIMIT_RPS,
  rateLimitBurst: DEFAULT_RATE_LIMIT_BURST,
  connectionsPerIp: DEFAULT_CONNECTIONS_PER_IP,
  customHeaders: [],
  customRewrites: [],
  accessList: null,
  advancedConfig: null,
  logPath: '/var/log/nginx/proxy-00000000',
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class NginxTemplateService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitTemplate(id: string, action: string) {
    this.eventBus?.publish('nginx.template.changed', { id, action });
  }

  // -----------------------------------------------------------------------
  // Seed built-in templates
  // -----------------------------------------------------------------------

  async seedBuiltinTemplates(): Promise<void> {
    for (const template of BUILTIN_TEMPLATES) {
      const existing = await this.db.query.nginxTemplates.findFirst({
        where: (t, { and, eq }) => and(eq(t.name, template.name), eq(t.isBuiltin, true)),
      });
      if (!existing) {
        await this.db.insert(nginxTemplates).values({
          ...template,
          isBuiltin: true,
        });
        logger.info('Seeded built-in nginx template', { name: template.name });
      } else if (
        existing.content !== template.content ||
        JSON.stringify(existing.variables ?? []) !== JSON.stringify(template.variables)
      ) {
        await this.db
          .update(nginxTemplates)
          .set({ content: template.content, variables: template.variables, updatedAt: new Date() })
          .where(eq(nginxTemplates.id, existing.id));
        logger.info('Updated built-in nginx template', { name: template.name });
      }
    }
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  async listTemplates(options?: { allowedIds?: string[] }) {
    if (options?.allowedIds?.length === 0) return [];
    return this.db.query.nginxTemplates.findMany({
      where: options?.allowedIds ? inArray(nginxTemplates.id, options.allowedIds) : undefined,
      orderBy: (t, { asc }) => [asc(t.name)],
    });
  }

  async getTemplate(id: string) {
    const template = await this.db.query.nginxTemplates.findFirst({
      where: eq(nginxTemplates.id, id),
    });
    if (!template) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Nginx template not found');
    return template;
  }

  async createTemplate(input: CreateNginxTemplateInput, userId: string) {
    // Validate the template compiles
    this.compileTemplate(input.content);

    const [template] = await this.db
      .insert(nginxTemplates)
      .values({
        ...input,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'nginx_template.create',
      resourceType: 'nginx_template',
      resourceId: template.id,
      details: { name: template.name },
    });

    this.emitTemplate(template.id, 'created');
    return template;
  }

  async updateTemplate(id: string, input: UpdateNginxTemplateInput, userId: string) {
    const existing = await this.getTemplate(id);
    if (existing.isBuiltin) throw new AppError(403, 'BUILTIN_IMMUTABLE', 'Built-in templates cannot be modified');

    if (input.content) {
      this.compileTemplate(input.content);
    }

    const [updated] = await this.db
      .update(nginxTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(nginxTemplates.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'nginx_template.update',
      resourceType: 'nginx_template',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });

    this.emitTemplate(id, 'updated');
    return updated;
  }

  async deleteTemplate(id: string, userId: string) {
    const existing = await this.getTemplate(id);
    if (existing.isBuiltin) throw new AppError(403, 'BUILTIN_IMMUTABLE', 'Built-in templates cannot be deleted');

    // Check no proxy hosts using it
    const [{ count: usageCount }] = await this.db
      .select({ count: count() })
      .from(proxyHosts)
      .where(eq(proxyHosts.nginxTemplateId, id));

    if (Number(usageCount) > 0) {
      throw new AppError(400, 'TEMPLATE_IN_USE', `Template is used by ${usageCount} proxy host(s)`);
    }

    await this.db.delete(nginxTemplates).where(eq(nginxTemplates.id, id));

    await this.auditService.log({
      userId,
      action: 'nginx_template.delete',
      resourceType: 'nginx_template',
      resourceId: id,
      details: { name: existing.name },
    });

    this.emitTemplate(id, 'deleted');
  }

  async cloneTemplate(id: string, userId: string) {
    const existing = await this.getTemplate(id);

    const [clone] = await this.db
      .insert(nginxTemplates)
      .values({
        name: `Copy of ${existing.name}`,
        description: existing.description,
        type: existing.type,
        content: existing.content,
        variables: existing.variables ?? [],
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'nginx_template.clone',
      resourceType: 'nginx_template',
      resourceId: clone.id,
      details: { sourceId: id, sourceName: existing.name },
    });

    this.emitTemplate(clone.id, 'created');
    return clone;
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  renderTemplate(content: string, host: ProxyHostConfig): string {
    const template = this.compileTemplate(content);
    const baseContext = this.buildBaseContext(host);
    const context = {
      ...baseContext,
      advancedConfig: host.advancedConfig ? this.renderTemplateString(host.advancedConfig, baseContext) : null,
    };
    return template(context);
  }

  async getBuiltinTemplateContent(type: string): Promise<string> {
    const template = await this.db.query.nginxTemplates.findFirst({
      where: (t, { and, eq }) => and(eq(t.type, type as any), eq(t.isBuiltin, true)),
    });
    if (template) return template.content;

    // Fallback to hardcoded if DB not seeded yet
    switch (type) {
      case 'proxy':
        return BUILTIN_PROXY_TEMPLATE;
      case 'redirect':
        return BUILTIN_REDIRECT_TEMPLATE;
      case '404':
        return BUILTIN_DEAD_TEMPLATE;
      default:
        return `# No built-in template for type: ${type}\n`;
    }
  }

  async renderForHost(host: ProxyHostConfig, templateId: string | null, hideExternalBranding = false): Promise<string> {
    let content: string;
    let managedBuiltin = !templateId;
    if (templateId) {
      const template = await this.getTemplate(templateId);
      content = template.content;
      managedBuiltin = template.isBuiltin && template.type === 'proxy';
    } else {
      content = await this.getBuiltinTemplateContent(host.type);
    }
    const rendered = this.renderTemplate(content, host).replaceAll(
      escapeNginxReturnText(GATEWAY_NOT_FOUND_HTML),
      escapeNginxReturnText(gatewayNotFoundHtml(hideExternalBranding))
    );
    const withSecureLinkUpstreams = this.ensureManagedAdditionalSecureLinkUpstreams(
      this.ensureManagedSecureLinkUpstream(rendered, host),
      host
    );
    return managedBuiltin
      ? this.ensureManagedAdditionalRouteUpstreams(withSecureLinkUpstreams, host)
      : withSecureLinkUpstreams;
  }

  private ensureManagedAdditionalSecureLinkUpstreams(rendered: string, host: ProxyHostConfig): string {
    const declarations = (host.additionalSecureLinks ?? []).flatMap((binding) => {
      const upstreamName = `gateway_additional_secure_link_${binding.id.replace(/-/g, '_')}`;
      const declaration = new RegExp(`(^|\\n)[\\t ]*upstream[\\t ]+${upstreamName}[\\t ]*\\{`, 'm');
      if (declaration.test(rendered)) return [];
      return [`upstream ${upstreamName} {\n    server unix:${binding.socketPath};\n    keepalive 64;\n}`];
    });
    return declarations.length > 0 ? `${declarations.join('\n\n')}\n\n${rendered}` : rendered;
  }

  private ensureManagedAdditionalRouteUpstreams(rendered: string, host: ProxyHostConfig): string {
    const declarations = (host.additionalRoutes ?? [])
      .filter((route) => route.secureLinkUpstream && route.secureLinkSocketPath)
      .flatMap((route) => {
        const upstreamName = `gateway_additional_secure_link_${route.id.replace(/-/g, '_')}`;
        const declaration = new RegExp(`(^|\\n)[\\t ]*upstream[\\t ]+${upstreamName}[\\t ]*\\{`, 'm');
        if (declaration.test(rendered)) return [];
        return [`upstream ${upstreamName} {\n    server unix:${route.secureLinkSocketPath};\n    keepalive 64;\n}`];
      });
    return declarations.length > 0 ? `${declarations.join('\n\n')}\n\n${rendered}` : rendered;
  }

  private ensureManagedSecureLinkUpstream(rendered: string, host: ProxyHostConfig): string {
    if (!host.secureLinkUpstream) return rendered;

    const upstreamName = `gateway_secure_link_${host.id.replace(/-/g, '_')}`;
    const upstreamDeclaration = new RegExp(`(^|\\n)[\\t ]*upstream[\\t ]+${upstreamName}[\\t ]*\\{`, 'm');
    if (upstreamDeclaration.test(rendered)) return rendered;

    const socketPath = host.secureLinkSocketPath ?? `/run/gateway-secure-links/${host.id}.sock`;
    return `upstream ${upstreamName} {
    server unix:${socketPath};
    keepalive 64;
}

${rendered}`;
  }

  applyMaintenanceGuard(
    renderedConfig: string,
    access?: { hostId: string; secret: string },
    hideExternalBranding = false
  ): string {
    if (!access) return this.applyLegacyMaintenanceGuard(renderedConfig, hideExternalBranding);
    const cookieDirective = `proxy_set_header Cookie $gm_cookie_${maintenanceAccessVariable(access.hostId)};`;
    const guarded = this.appendLocationDirective(this.stripProxyCookieHeaders(renderedConfig), cookieDirective).replace(
      /^[\t ]*server[\t ]*\{/gm,
      (match) => `${match}${maintenanceServerGuard(access.hostId, access.secret, hideExternalBranding)}`
    );
    if (!/^[\t ]*server[\t ]*\{/m.test(renderedConfig)) {
      throw new AppError(500, 'MAINTENANCE_CONFIG_INVALID', 'Rendered proxy config has no server block');
    }
    return `${maintenanceMaps(access.hostId)}\n${guarded}`;
  }

  private applyLegacyMaintenanceGuard(renderedConfig: string, hideExternalBranding: boolean): string {
    let serverCount = 0;
    const guarded = renderedConfig.replace(/^[\t ]*server[\t ]*\{/gm, (match) => {
      serverCount += 1;
      return `${match}${LEGACY_MAINTENANCE_SERVER_GUARD.replace(
        escapeNginxReturnText(GATEWAY_MAINTENANCE_HTML),
        escapeNginxReturnText(gatewayMaintenanceHtml(hideExternalBranding))
      )}`;
    });

    if (serverCount === 0) {
      throw new AppError(500, 'MAINTENANCE_CONFIG_INVALID', 'Rendered proxy config has no server block');
    }

    return guarded;
  }

  /**
   * A location-level proxy_set_header disables server-level inheritance and
   * duplicate Cookie headers can be forwarded independently. Replace every
   * rendered Cookie override with the managed, sanitized value below. This
   * operates only on the generated deployment config; no stored user config
   * is edited.
   */
  private stripProxyCookieHeaders(renderedConfig: string): string {
    return renderedConfig.replace(/(^|[;{}])\s*proxy_set_header\s+Cookie\s+[^;]*;/gim, '$1');
  }

  private appendLocationDirective(renderedConfig: string, directive: string): string {
    let result = '';
    let header = '';
    let quote: '"' | "'" | null = null;
    let inComment = false;
    const blocks: boolean[] = [];

    for (let index = 0; index < renderedConfig.length; index++) {
      const char = renderedConfig[index]!;
      if (inComment) {
        result += char;
        if (char === '\n') inComment = false;
        continue;
      }
      if (quote) {
        result += char;
        if (char === quote && renderedConfig[index - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '#') {
        result += char;
        inComment = true;
        continue;
      }
      if (char === '"' || char === "'") {
        result += char;
        quote = char;
        continue;
      }
      if (char === '{') {
        blocks.push(/^\s*location\b/i.test(header));
        header = '';
        result += char;
        continue;
      }
      if (char === '}') {
        if (blocks.pop()) result += `\n        ${directive}\n`;
        header = '';
        result += char;
        continue;
      }
      result += char;
      if (char === ';') header = '';
      else header += char;
    }
    return result;
  }

  previewWithSampleData(content: string): string {
    return this.renderTemplateString(content, SAMPLE_CONTEXT);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private compileTemplate(content: string): HandlebarsTemplateDelegate {
    try {
      return Handlebars.compile(content, { noEscape: true });
    } catch (err) {
      throw new AppError(
        400,
        'INVALID_TEMPLATE',
        `Template compilation error: ${err instanceof Error ? err.message : 'unknown'}`
      );
    }
  }

  private renderTemplateString(content: string, context: Record<string, unknown>): string {
    const template = this.compileTemplate(content);
    return template(context);
  }

  private buildBaseContext(host: ProxyHostConfig): Record<string, unknown> {
    const serverNames = host.domainNames.map((d) => d.replace(DANGEROUS_CHARS, '')).join(' ');
    const sanitizedHost = host.forwardHost ? host.forwardHost.replace(DANGEROUS_CHARS, '') : '';
    const secureLinkUpstreamName = `gateway_secure_link_${host.id.replace(/-/g, '_')}`;
    const secureLinkSocketPath = `/run/gateway-secure-links/${host.id}.sock`;
    const upstream = host.secureLinkUpstream
      ? `${host.forwardScheme}://${secureLinkUpstreamName}`
      : `${host.forwardScheme}://${formatHostPort(sanitizedHost, host.forwardPort ?? 0)}`;

    const opts = (host.rateLimitOptions ?? {}) as Record<string, unknown>;
    const cacheOpts = (host.cacheOptions ?? {}) as Record<string, unknown>;
    const templateVariables = this.sanitizeTemplateVariables(host.templateVariables ?? {});
    const cacheEnabled =
      typeof templateVariables.cacheEnabled === 'boolean' ? templateVariables.cacheEnabled : host.cacheEnabled;
    const cacheMaxAge =
      typeof templateVariables.cacheMaxAge === 'number' ? templateVariables.cacheMaxAge : (cacheOpts.maxAge ?? 3600);
    const configuredRateLimitMode =
      templateVariables.rateLimitMode === 'inherit' ||
      templateVariables.rateLimitMode === 'custom' ||
      templateVariables.rateLimitMode === 'disabled'
        ? templateVariables.rateLimitMode
        : (host.rateLimitMode ?? (host.rateLimitEnabled ? 'custom' : 'inherit'));
    const rateLimitRPS =
      configuredRateLimitMode === 'custom'
        ? typeof templateVariables.rateLimitRPS === 'number'
          ? templateVariables.rateLimitRPS
          : (opts.requestsPerSecond ?? DEFAULT_RATE_LIMIT_RPS)
        : DEFAULT_RATE_LIMIT_RPS;
    const rateLimitBurst =
      configuredRateLimitMode === 'custom'
        ? typeof templateVariables.rateLimitBurst === 'number'
          ? templateVariables.rateLimitBurst
          : (opts.burst ?? DEFAULT_RATE_LIMIT_BURST)
        : DEFAULT_RATE_LIMIT_BURST;
    const connectionsPerIp =
      configuredRateLimitMode === 'custom'
        ? typeof templateVariables.connectionsPerIp === 'number'
          ? templateVariables.connectionsPerIp
          : (opts.connectionsPerIp ?? DEFAULT_CONNECTIONS_PER_IP)
        : DEFAULT_CONNECTIONS_PER_IP;
    const additionalSecureLinks = Object.fromEntries(
      (host.additionalSecureLinks ?? []).map((binding) => [
        binding.name,
        `${binding.scheme}://gateway_additional_secure_link_${binding.id.replace(/-/g, '_')}`,
      ])
    );

    return {
      id: host.id,
      serverNames,
      upstream,
      forwardScheme: host.forwardScheme,
      forwardHost: sanitizedHost,
      forwardPort: host.forwardPort,
      sslEnabled: host.sslEnabled,
      sslForced: host.sslForced,
      http2Support: host.http2Support,
      websocketSupport: host.websocketSupport,
      secureLinkUpstream: host.secureLinkUpstream === true,
      secureLinkUpstreamName,
      secureLinkSocketPath,
      sslCertPath: host.sslCertPath,
      sslKeyPath: host.sslKeyPath,
      sslChainPath: host.sslChainPath,
      redirectUrl: host.redirectUrl,
      redirectStatusCode: host.redirectStatusCode,
      cacheStale: cacheOpts.staleWhileRevalidate ?? 60,
      customHeaders: host.customHeaders,
      customRewrites: host.customRewrites,
      accessList: host.accessList,
      accessListHasIpRules: (host.accessList?.ipRules?.length ?? 0) > 0,
      logPath: `${NGINX_LOGS_PREFIX}/proxy-${host.id}`,
      // Custom variables remain available to user templates; managed built-ins above
      // are written last so their derived values cannot become internally inconsistent.
      ...templateVariables,
      pagesRouteIncludePath: host.pagesRouteIncludePath,
      additionalRoutes: host.additionalRoutes ?? [],
      cacheEnabled,
      cacheMaxAge,
      rateLimitMode: configuredRateLimitMode,
      rateLimitEnabled: configuredRateLimitMode !== 'disabled',
      rateLimitRPS,
      rateLimitBurst,
      connectionsPerIp,
      additionalSecureLinks,
    };
  }

  private sanitizeTemplateVariables(
    vars: Record<string, string | number | boolean>
  ): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string') {
        sanitized[key] = value.replace(DANGEROUS_CHARS, '');
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
