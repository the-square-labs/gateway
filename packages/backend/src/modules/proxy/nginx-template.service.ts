import { count, eq, inArray } from 'drizzle-orm';
import Handlebars from 'handlebars';
import type { DrizzleClient } from '@/db/client.js';
import { nginxTemplates } from '@/db/schema/nginx-templates.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { escapeNginxReturnText, GATEWAY_MAINTENANCE_HTML, GATEWAY_NOT_FOUND_HTML } from '@/lib/gateway-error-pages.js';
import { createChildLogger } from '@/lib/logger.js';
import { formatHostPort } from '@/lib/network-endpoint.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { injectAccessListIntoAdvancedLocations } from '@/services/nginx-advanced-location.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import type { CreateNginxTemplateInput, UpdateNginxTemplateInput } from './nginx-template.schemas.js';

const logger = createChildLogger('NginxTemplateService');

const NGINX_LOGS_PREFIX = '/var/log/nginx';

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
        limit_req zone=ratelimit_{{id}} burst={{rateLimitBurst}} nodelay;
{{/if}}
{{#if cacheEnabled}}
        proxy_cache cache_{{id}};
        proxy_cache_valid 200 301 302 {{cacheMaxAge}}s;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        add_header X-Cache-Status $upstream_cache_status;
{{/if}}
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

        proxy_connect_timeout 60s;
        proxy_send_timeout {{#if secureLinkUpstream}}2h{{else}}60s{{/if}};
        proxy_read_timeout {{#if secureLinkUpstream}}2h{{else}}60s{{/if}};

{{#if websocketSupport}}
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

{{/if}}
{{#each customHeaders}}
        proxy_set_header {{sanitize this.name}} "{{sanitize this.value}}";
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

const MAINTENANCE_SERVER_GUARD = `
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
  },
  {
    name: 'Default Redirect',
    description: 'HTTP redirect with optional SSL termination.',
    type: 'redirect' as const,
    content: BUILTIN_REDIRECT_TEMPLATE,
  },
  {
    name: 'Default 404',
    description: 'Returns 404 for all requests. Use to block domains.',
    type: '404' as const,
    content: BUILTIN_DEAD_TEMPLATE,
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
  rateLimitEnabled: false,
  rateLimitRPS: 10,
  rateLimitBurst: 20,
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
      } else if (existing.content !== template.content) {
        await this.db
          .update(nginxTemplates)
          .set({ content: template.content, updatedAt: new Date() })
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

  async renderForHost(host: ProxyHostConfig, templateId: string | null): Promise<string> {
    let content: string;
    if (templateId) {
      const template = await this.getTemplate(templateId);
      content = template.content;
    } else {
      content = await this.getBuiltinTemplateContent(host.type);
    }
    return this.renderTemplate(content, host);
  }

  applyMaintenanceGuard(renderedConfig: string): string {
    let serverCount = 0;
    const guarded = renderedConfig.replace(/^[\t ]*server[\t ]*\{/gm, (match) => {
      serverCount += 1;
      return `${match}${MAINTENANCE_SERVER_GUARD}`;
    });

    if (serverCount === 0) {
      throw new AppError(500, 'MAINTENANCE_CONFIG_INVALID', 'Rendered proxy config has no server block');
    }

    return guarded;
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
    const upstream = `${host.forwardScheme}://${formatHostPort(sanitizedHost, host.forwardPort ?? 0)}`;

    const opts = (host.rateLimitOptions ?? {}) as Record<string, unknown>;
    const cacheOpts = (host.cacheOptions ?? {}) as Record<string, unknown>;

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
      sslCertPath: host.sslCertPath,
      sslKeyPath: host.sslKeyPath,
      sslChainPath: host.sslChainPath,
      redirectUrl: host.redirectUrl,
      redirectStatusCode: host.redirectStatusCode,
      cacheEnabled: host.cacheEnabled,
      cacheMaxAge: cacheOpts.maxAge ?? 3600,
      cacheStale: cacheOpts.staleWhileRevalidate ?? 60,
      rateLimitEnabled: host.rateLimitEnabled,
      rateLimitRPS: opts.requestsPerSecond ?? 10,
      rateLimitBurst: opts.burst ?? 20,
      customHeaders: host.customHeaders,
      customRewrites: host.customRewrites,
      accessList: host.accessList,
      accessListHasIpRules: (host.accessList?.ipRules?.length ?? 0) > 0,
      logPath: `${NGINX_LOGS_PREFIX}/proxy-${host.id}`,
      // Merge custom template variables (sanitized — user-defined values override defaults)
      ...this.sanitizeTemplateVariables(host.templateVariables ?? {}),
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
