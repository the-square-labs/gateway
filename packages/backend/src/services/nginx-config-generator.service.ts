import { createChildLogger } from '@/lib/logger.js';
import { formatHostPort, isValidUpstreamHost } from '@/lib/network-endpoint.js';
import type { ConfigValidatorService } from './config-validator.service.js';
import { injectAccessListIntoAdvancedLocations } from './nginx-advanced-location.js';

const logger = createChildLogger('NginxConfigGenerator');

/** Nginx sees certs under this path on the daemon host. */
const NGINX_CERTS_PREFIX = '/etc/nginx/certs';

/** Nginx logs directory on the daemon host. */
const NGINX_LOGS_PREFIX = '/var/log/nginx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyHostConfig {
  id: string;
  type: 'proxy' | 'redirect' | '404' | 'raw';
  domainNames: string[];
  enabled: boolean;
  forwardHost: string | null;
  forwardPort: number | null;
  forwardScheme: 'http' | 'https';
  sslEnabled: boolean;
  sslForced: boolean;
  http2Support: boolean;
  websocketSupport: boolean;
  redirectUrl: string | null;
  redirectStatusCode: number;
  customHeaders: { name: string; value: string }[];
  cacheEnabled: boolean;
  cacheOptions: Record<string, unknown> | null;
  rateLimitEnabled: boolean;
  rateLimitOptions: Record<string, unknown> | null;
  customRewrites: { source: string; destination: string; type: string }[];
  advancedConfig: string | null;
  accessList: {
    id: string;
    ipRules: { type: string; value: string }[];
    basicAuthEnabled: boolean;
  } | null;
  sslCertPath: string | null;
  sslKeyPath: string | null;
  sslChainPath: string | null;
  templateVariables?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Service — pure config generation, no file I/O, no Docker
// ---------------------------------------------------------------------------

export class NginxConfigGenerator {
  constructor(private readonly configValidator: ConfigValidatorService) {}

  // -----------------------------------------------------------------------
  // Input sanitization
  // -----------------------------------------------------------------------

  private sanitizeNginxValue(value: string): string {
    return value.replace(/[\n\r;'"{}`$#]/g, '');
  }

  private buildAccessListDirectives(accessList: ProxyHostConfig['accessList']): string[] {
    if (!accessList) return [];

    const directives = accessList.ipRules.map((rule) => {
      const safeType = this.sanitizeNginxValue(rule.type);
      const safeValue = this.sanitizeNginxValue(rule.value);
      return `${safeType} ${safeValue};`;
    });
    if (accessList.ipRules.length > 0) directives.push('deny all;');
    if (accessList.basicAuthEnabled) {
      directives.push('auth_basic "Restricted Access";');
      directives.push(
        `auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-${this.sanitizeNginxValue(accessList.id)};`
      );
    }
    return directives;
  }

  private validateForwardHost(host: string): string {
    if (!isValidUpstreamHost(host)) {
      throw new Error(`Invalid forwardHost value: ${host}`);
    }
    return host;
  }

  // -----------------------------------------------------------------------
  // Config generation — public entry point
  // -----------------------------------------------------------------------

  generateConfig(host: ProxyHostConfig): string {
    if (host.sslEnabled && (!host.sslCertPath || !host.sslKeyPath)) {
      logger.warn('SSL enabled but no certificate paths set, disabling SSL for host', { hostId: host.id });
      host = { ...host, sslEnabled: false, sslForced: false };
    }

    switch (host.type) {
      case 'proxy':
        return this.generateProxyConfig(host);
      case 'redirect':
        return this.generateRedirectConfig(host);
      case '404':
        return this.generateDeadConfig(host);
      default:
        return `# Raw config type — no template generation\n`;
    }
  }

  // -----------------------------------------------------------------------
  // Proxy server block
  // -----------------------------------------------------------------------

  private generateProxyConfig(host: ProxyHostConfig): string {
    const serverNames = host.domainNames.map((d) => this.sanitizeNginxValue(d)).join(' ');
    const sanitizedHost = host.forwardHost ? this.validateForwardHost(host.forwardHost) : '';
    const upstream = `${host.forwardScheme}://${formatHostPort(sanitizedHost, host.forwardPort ?? 0)}`;
    const lines: string[] = [];
    let rateLimitBurst = 20;

    if (host.rateLimitEnabled && host.rateLimitOptions) {
      const opts = host.rateLimitOptions as Record<string, unknown>;
      const rps = opts.requestsPerSecond ?? 10;
      rateLimitBurst = (opts.burst as number) ?? 20;
      lines.push(`limit_req_zone $binary_remote_addr zone=ratelimit_${host.id}:10m rate=${rps}r/s;`);
      lines.push('');
    }

    if (host.cacheEnabled && host.cacheOptions) {
      const maxAge = (host.cacheOptions as Record<string, unknown>).maxAge ?? 3600;
      lines.push(
        `proxy_cache_path /tmp/nginx-cache-${host.id} levels=1:2 keys_zone=cache_${host.id}:10m max_size=100m inactive=${maxAge}s;`
      );
      lines.push('');
    }

    if (host.sslEnabled && host.sslForced) {
      lines.push('server {');
      lines.push('    listen 80;');
      lines.push('    listen [::]:80;');
      lines.push(`    server_name ${serverNames};`);
      lines.push('');
      lines.push('    # ACME challenge');
      lines.push('    location /.well-known/acme-challenge/ {');
      lines.push('        alias /var/www/acme-challenge/;');
      lines.push('        auth_basic off;');
      lines.push('    }');
      lines.push('');
      lines.push('    location / {');
      lines.push('        return 301 https://$host$request_uri;');
      lines.push('    }');
      lines.push('}');
      lines.push('');
    }

    lines.push('server {');

    if (!host.sslEnabled || !host.sslForced) {
      lines.push('    listen 80;');
      lines.push('    listen [::]:80;');
    }

    if (host.sslEnabled) {
      lines.push('    listen 443 ssl;');
      lines.push('    listen [::]:443 ssl;');
      if (host.http2Support) lines.push('    http2 on;');
    }

    lines.push(`    server_name ${serverNames};`);
    lines.push('');

    if (host.sslEnabled) {
      if (host.sslCertPath) lines.push(`    ssl_certificate ${host.sslCertPath};`);
      if (host.sslKeyPath) lines.push(`    ssl_certificate_key ${host.sslKeyPath};`);
      if (host.sslChainPath) lines.push(`    ssl_trusted_certificate ${host.sslChainPath};`);
      lines.push('');
    }

    lines.push(`    access_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.access.log;`);
    lines.push(`    error_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.error.log warn;`);
    lines.push('');

    if (!host.sslForced) {
      lines.push('    # ACME challenge');
      lines.push('    location /.well-known/acme-challenge/ {');
      lines.push('        alias /var/www/acme-challenge/;');
      lines.push('        auth_basic off;');
      lines.push('    }');
      lines.push('');
    }

    lines.push('    location / {');

    for (const directive of this.buildAccessListDirectives(host.accessList)) {
      lines.push(`        ${directive}`);
    }
    if (host.accessList) lines.push('');

    if (host.rateLimitEnabled && host.rateLimitOptions) {
      lines.push(`        limit_req zone=ratelimit_${host.id} burst=${rateLimitBurst} nodelay;`);
    }

    if (host.cacheEnabled && host.cacheOptions) {
      lines.push(`        proxy_cache cache_${host.id};`);
      lines.push(
        `        proxy_cache_valid 200 301 302 ${(host.cacheOptions as Record<string, unknown>).maxAge ?? 3600}s;`
      );
      lines.push('        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;');
      lines.push('        proxy_cache_background_update on;');
      lines.push('        add_header X-Cache-Status $upstream_cache_status;');
    }

    lines.push(`        proxy_pass ${upstream};`);
    lines.push('');
    lines.push('        proxy_set_header Host $host;');
    lines.push('        proxy_set_header X-Real-IP $remote_addr;');
    lines.push('        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    lines.push('        proxy_set_header X-Forwarded-Proto $scheme;');
    lines.push('        proxy_set_header X-Forwarded-Host $host;');
    lines.push('        proxy_set_header X-Forwarded-Port $server_port;');
    lines.push('');
    lines.push('        proxy_connect_timeout 60s;');
    lines.push('        proxy_send_timeout 60s;');
    lines.push('        proxy_read_timeout 60s;');
    lines.push('');

    if (host.websocketSupport) {
      lines.push('        # WebSocket support');
      lines.push('        proxy_http_version 1.1;');
      lines.push('        proxy_set_header Upgrade $http_upgrade;');
      lines.push('        proxy_set_header Connection "upgrade";');
      lines.push('');
    }

    if (host.customHeaders.length > 0) {
      lines.push('        # Custom headers');
      for (const header of host.customHeaders) {
        const safeName = this.sanitizeNginxValue(header.name);
        const safeValue = this.sanitizeNginxValue(header.value);
        lines.push(`        proxy_set_header ${safeName} "${safeValue}";`);
      }
      lines.push('');
    }

    if (host.customRewrites.length > 0) {
      lines.push('        # URL rewrites');
      for (const rewrite of host.customRewrites) {
        const flag = rewrite.type === 'permanent' ? 'permanent' : 'redirect';
        const safeSource = this.sanitizeNginxValue(rewrite.source);
        const safeDest = this.sanitizeNginxValue(rewrite.destination);
        lines.push(`        rewrite ${safeSource} ${safeDest} ${flag};`);
      }
      lines.push('');
    }

    lines.push('    }');

    if (host.advancedConfig) {
      lines.push('');
      lines.push('    # Advanced custom config');
      const protectedAdvancedConfig = injectAccessListIntoAdvancedLocations(
        host.advancedConfig,
        this.buildAccessListDirectives(host.accessList)
      );
      for (const line of protectedAdvancedConfig.split('\n')) {
        lines.push(`    ${line}`);
      }
    }

    lines.push('}');

    return `${lines.join('\n')}\n`;
  }

  // -----------------------------------------------------------------------
  // Redirect server block
  // -----------------------------------------------------------------------

  private generateRedirectConfig(host: ProxyHostConfig): string {
    const serverNames = host.domainNames.map((d) => this.sanitizeNginxValue(d)).join(' ');
    const statusCode = host.redirectStatusCode || 301;
    const redirectUrl = this.sanitizeNginxValue(host.redirectUrl ?? '/');
    const lines: string[] = [];

    lines.push('server {');
    lines.push('    listen 80;');
    lines.push('    listen [::]:80;');
    lines.push(`    server_name ${serverNames};`);
    lines.push('');
    lines.push(`    access_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.access.log;`);
    lines.push(`    error_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.error.log warn;`);
    lines.push('');
    lines.push('    # ACME challenge');
    lines.push('    location /.well-known/acme-challenge/ {');
    lines.push('        alias /var/www/acme-challenge/;');
    lines.push('        auth_basic off;');
    lines.push('    }');
    lines.push('');

    if (host.sslEnabled && host.sslForced) {
      lines.push('    location / {');
      lines.push('        return 301 https://$host$request_uri;');
      lines.push('    }');
    } else {
      lines.push('    location / {');
      lines.push(`        return ${statusCode} ${redirectUrl};`);
      lines.push('    }');
    }

    lines.push('}');

    if (host.sslEnabled) {
      lines.push('');
      lines.push('server {');
      lines.push('    listen 443 ssl;');
      lines.push('    listen [::]:443 ssl;');
      if (host.http2Support) lines.push('    http2 on;');
      lines.push(`    server_name ${serverNames};`);
      lines.push('');

      if (host.sslCertPath) lines.push(`    ssl_certificate ${host.sslCertPath};`);
      if (host.sslKeyPath) lines.push(`    ssl_certificate_key ${host.sslKeyPath};`);
      if (host.sslChainPath) lines.push(`    ssl_trusted_certificate ${host.sslChainPath};`);
      lines.push('');
      lines.push(`    access_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.access.log;`);
      lines.push(`    error_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.error.log warn;`);
      lines.push('');
      lines.push('    location / {');
      lines.push(`        return ${statusCode} ${redirectUrl};`);
      lines.push('    }');
      lines.push('}');
    }

    return `${lines.join('\n')}\n`;
  }

  // -----------------------------------------------------------------------
  // Dead (404) server block
  // -----------------------------------------------------------------------

  private generateDeadConfig(host: ProxyHostConfig): string {
    const serverNames = host.domainNames.map((d) => this.sanitizeNginxValue(d)).join(' ');
    const lines: string[] = [];

    lines.push('server {');
    lines.push('    listen 80;');
    lines.push('    listen [::]:80;');
    lines.push(`    server_name ${serverNames};`);
    lines.push('');
    lines.push(`    access_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.access.log;`);
    lines.push(`    error_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.error.log warn;`);
    lines.push('');
    lines.push('    location / {');
    lines.push('        return 404;');
    lines.push('    }');
    lines.push('}');

    if (host.sslEnabled) {
      lines.push('');
      lines.push('server {');
      lines.push('    listen 443 ssl;');
      lines.push('    listen [::]:443 ssl;');
      if (host.http2Support) lines.push('    http2 on;');
      lines.push(`    server_name ${serverNames};`);
      lines.push('');
      if (host.sslCertPath) lines.push(`    ssl_certificate ${host.sslCertPath};`);
      if (host.sslKeyPath) lines.push(`    ssl_certificate_key ${host.sslKeyPath};`);
      if (host.sslChainPath) lines.push(`    ssl_trusted_certificate ${host.sslChainPath};`);
      lines.push('');
      lines.push(`    access_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.access.log;`);
      lines.push(`    error_log ${NGINX_LOGS_PREFIX}/proxy-${host.id}.error.log warn;`);
      lines.push('');
      lines.push('    location / {');
      lines.push('        return 404;');
      lines.push('    }');
      lines.push('}');
    }

    return `${lines.join('\n')}\n`;
  }

  // -----------------------------------------------------------------------
  // Advanced config validation
  // -----------------------------------------------------------------------

  validateAdvancedConfig(
    snippet: string,
    rawMode = false,
    bypassRawValidation = false
  ): { valid: boolean; errors: string[] } {
    return this.configValidator.validate(snippet, rawMode, bypassRawValidation);
  }

  // -----------------------------------------------------------------------
  // Cert path helpers (pure computation, no file I/O)
  // -----------------------------------------------------------------------

  getCertPaths(certId: string): { certPath: string; keyPath: string; chainPath: string } {
    return {
      certPath: `${NGINX_CERTS_PREFIX}/${certId}/fullchain.pem`,
      keyPath: `${NGINX_CERTS_PREFIX}/${certId}/privkey.pem`,
      chainPath: `${NGINX_CERTS_PREFIX}/${certId}/chain.pem`,
    };
  }

  /**
   * v2 distribution never points a proxy config at a mutable certificate
   * file. The daemon switches this `current` symlink only after staging the
   * complete certificate/key pair, so an Nginx reload cannot observe a half
   * written certificate.
   */
  getVersionedCertPaths(certId: string): { certPath: string; keyPath: string; chainPath: string } {
    return {
      certPath: `${NGINX_CERTS_PREFIX}/${certId}/current/fullchain.pem`,
      keyPath: `${NGINX_CERTS_PREFIX}/${certId}/current/privkey.pem`,
      chainPath: `${NGINX_CERTS_PREFIX}/${certId}/current/chain.pem`,
    };
  }
}
