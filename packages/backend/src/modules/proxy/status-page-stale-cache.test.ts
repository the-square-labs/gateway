import { describe, expect, it, vi } from 'vitest';
import { GATEWAY_STATUS_PAGE_UNAVAILABLE_HTML, gatewayStatusPageUnavailableHtml } from '@/lib/gateway-error-pages.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';
import {
  STATUS_PAGE_CACHE_VALID_SECONDS,
  statusPageCachePath,
  statusPageCacheZone,
  statusPageFallbackLocation,
  withStatusPageStaleCache,
} from './status-page-stale-cache.js';

vi.mock('@/db/schema/proxy-hosts.js', () => ({ proxyHosts: { nginxTemplateId: 'nginx_template_id' } }));
vi.mock('@/db/schema/nginx-templates.js', () => ({
  nginxTemplates: { id: 'nginx_templates.id', type: 'nginx_templates.type', isBuiltin: 'nginx_templates.is_builtin' },
}));

const HOST_ID = '44444444-4444-4444-8444-444444444444';

/** The status page system host as proxy.service.system-hosts renders it: Gateway upstream, TLS forced. */
const statusHost: ProxyHostConfig = {
  id: HOST_ID,
  type: 'proxy',
  domainNames: ['status.example.com'],
  enabled: true,
  forwardHost: '10.0.0.5',
  forwardPort: 3000,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: false,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  accessList: null,
  sslCertPath: '/etc/nginx/certs/status.crt',
  sslKeyPath: '/etc/nginx/certs/status.key',
  sslChainPath: null,
  statusPageStaleCache: true,
};

function templates() {
  return new NginxTemplateService(
    { query: { nginxTemplates: { findFirst: async () => undefined } } } as any,
    {} as any
  );
}

function blockAt(config: string, start: number): string {
  let depth = 0;
  const open = config.indexOf('{', start);
  for (let index = open; index < config.length; index++) {
    if (config[index] === '{') depth += 1;
    if (config[index] === '}' && --depth === 0) return config.slice(open + 1, index);
  }
  throw new Error('unbalanced block');
}

/** The body of the first location block whose header matches. */
function locationBody(config: string, header: RegExp): string {
  const match = header.exec(config);
  expect(match).not.toBeNull();
  return blockAt(config, match!.index);
}

/** The body of `location /` in the server that proxies (the HTTP server of a TLS-forced route only redirects). */
function proxyingRoot(config: string): string {
  const bodies = [...config.matchAll(/^[\t ]*location \/ \{/gm)].map((match) => blockAt(config, match.index!));
  const proxying = bodies.filter((body) => body.includes('proxy_pass'));
  expect(proxying).toHaveLength(1);
  return proxying[0]!;
}

function balanced(config: string): boolean {
  let depth = 0;
  for (const char of config.replace(/'(?:\\.|[^'\\])*'/g, "''")) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('status page route keeps serving while Gateway is unreachable (C-2)', () => {
  it('caches the page, its assets and the status API it polls, and serves them stale on Gateway errors', async () => {
    const rendered = await templates().renderForHost(statusHost, null);
    expect(balanced(rendered)).toBe(true);
    // The zone lives at http level, in the directory the nginx daemon removes with the host config.
    expect(rendered.startsWith(`proxy_cache_path ${statusPageCachePath(HOST_ID)} levels=1:2`)).toBe(true);
    expect(statusPageCachePath(HOST_ID)).toBe(`/tmp/nginx-cache-${HOST_ID}`);
    expect(rendered).toContain(
      `keys_zone=${statusPageCacheZone(HOST_ID)}:1m max_size=64m inactive=7d use_temp_path=off;`
    );
    const root = proxyingRoot(rendered);
    expect(root).toContain('proxy_pass http://10.0.0.5:3000;');
    expect(root).toContain(`proxy_cache ${statusPageCacheZone(HOST_ID)};`);
    expect(root).toContain('proxy_cache_key "$scheme$host$request_uri";');
    expect(root).toContain(`proxy_cache_valid 200 ${STATUS_PAGE_CACHE_VALID_SECONDS}s;`);
    expect(root).toContain(
      'proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504 http_429;'
    );
    // Gateway sends the page with Cache-Control: no-store for browsers; only the ingress cache ignores it.
    expect(root).toContain('proxy_ignore_headers Cache-Control Expires;');
    expect(root).not.toMatch(/Set-Cookie/);
    // Live data: no background update, which would always answer with the previous copy.
    expect(rendered).not.toContain('proxy_cache_background_update');
    // A dead Gateway fails over to the cached page in seconds; each timeout is set once (nginx rejects duplicates).
    expect(root.match(/proxy_connect_timeout/g)).toHaveLength(1);
    expect(root).toContain('proxy_connect_timeout 5s;');
    expect(root.match(/proxy_read_timeout/g)).toHaveLength(1);
    expect(root.match(/proxy_send_timeout/g)).toHaveLength(1);
    expect(root).not.toContain('60s');
    expect(root).toContain('proxy_intercept_errors on;');
    expect(root).toContain(`error_page 500 502 503 504 = ${statusPageFallbackLocation(HOST_ID)};`);
    // The ACME challenge location and the HTTP -> HTTPS redirect server are untouched.
    const acme = locationBody(rendered, /^[\t ]*location \/\.well-known\/acme-challenge\/ \{/m);
    expect(acme).not.toContain('proxy_cache');
    expect(rendered.match(new RegExp(`location ${statusPageFallbackLocation(HOST_ID)} \\{`, 'g'))).toHaveLength(1);
  });

  it('answers with a self-reloading fallback page when nothing is cached yet', async () => {
    const rendered = await templates().renderForHost(statusHost, null);
    const fallback = locationBody(
      rendered,
      new RegExp(`^[\\t ]*location ${statusPageFallbackLocation(HOST_ID)} \\{`, 'm')
    );
    expect(fallback).toContain('default_type text/html;');
    expect(fallback).toContain('add_header Cache-Control "no-store" always;');
    expect(fallback).toContain('add_header Retry-After 15 always;');
    expect(fallback).toMatch(/return 503 '<!doctype html>/);
    expect(GATEWAY_STATUS_PAGE_UNAVAILABLE_HTML).toContain('<meta http-equiv="refresh" content="15">');
    expect(fallback).toContain('Powered by');
    const unbranded = await templates().renderForHost(statusHost, null, true);
    expect(gatewayStatusPageUnavailableHtml(true)).not.toContain('Powered by');
    expect(
      locationBody(unbranded, new RegExp(`^[\\t ]*location ${statusPageFallbackLocation(HOST_ID)} \\{`, 'm'))
    ).not.toContain('Powered by');
  });

  it('works with a hostname upstream resolved at run time and with the maintenance guard applied afterwards', async () => {
    const service = templates();
    const rendered = await service.renderForHost(
      { ...statusHost, forwardHost: 'gateway.internal.example', upstreamIpv6Enabled: false },
      null
    );
    const root = proxyingRoot(rendered);
    expect(root).toMatch(/proxy_pass http:\/\/\$gw_up_[a-f0-9]{16}:3000;/);
    expect(root).toContain(`proxy_cache ${statusPageCacheZone(HOST_ID)};`);
    const guarded = service.applyMaintenanceGuard(rendered, { hostId: HOST_ID, secret: 'secret' });
    expect(balanced(guarded)).toBe(true);
    expect(guarded.startsWith('map ')).toBe(true);
    expect(guarded).toContain(`proxy_cache_path ${statusPageCachePath(HOST_ID)}`);
  });

  it('leaves every other route, a redirect, and a template that manages caching itself unchanged', async () => {
    const service = templates();
    const plain = await service.renderForHost({ ...statusHost, statusPageStaleCache: false }, null);
    expect(plain).not.toContain('proxy_cache');
    expect(plain).toContain('proxy_connect_timeout 60s;');
    expect(await service.renderForHost({ ...statusHost, statusPageStaleCache: undefined }, null)).toBe(plain);
    const cached = await service.renderForHost(
      { ...statusHost, cacheEnabled: true, cacheOptions: { maxAge: 30 } },
      null
    );
    expect(cached).not.toContain(statusPageCacheZone(HOST_ID));
    expect(cached).toContain(`proxy_cache cache_${HOST_ID};`);
    const redirect =
      'server {\n    listen 80;\n    location / {\n        return 301 https://$host$request_uri;\n    }\n}\n';
    expect(withStatusPageStaleCache(redirect, HOST_ID)).toBe(redirect);
  });

  it('only rewrites timeouts on the proxying location level, never inside nested blocks', () => {
    const config = [
      'server {',
      '    location / {',
      '        proxy_pass http://127.0.0.1:3000;',
      '        proxy_read_timeout 90s;',
      '        location /nested/ {',
      '            proxy_read_timeout 30s;',
      '            return 204;',
      '        }',
      '    }',
      '    location = /inline { return 200 "{ proxy_pass x; }"; }',
      '}',
      '',
    ].join('\n');
    const result = withStatusPageStaleCache(config, HOST_ID);
    expect(balanced(result)).toBe(true);
    const root = locationBody(result, /^[\t ]*location \/ \{/m);
    expect(root).toContain('proxy_read_timeout 30s;');
    expect(root).not.toContain('proxy_read_timeout 90s;');
    expect(root).toContain('proxy_read_timeout 15s;');
    expect(locationBody(result, /^[\t ]*location = \/inline \{/m)).not.toContain('proxy_cache');
  });
});
