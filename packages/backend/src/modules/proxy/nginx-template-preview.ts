import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NginxTemplateService } from './nginx-template.service.js';

type PreviewHost = Awaited<ReturnType<import('./proxy.service.js').ProxyService['getProxyHost']>>;

/**
 * Render template content with a stored host's settings, as the template
 * preview route does. The caller decides whether the host's advanced config
 * may be shown (proxy:advanced:<id>).
 */
export function renderTemplatePreviewForHost(
  service: NginxTemplateService,
  content: string,
  host: PreviewHost,
  includeAdvancedConfig: boolean
): string {
  return service.renderTemplate(content, {
    id: host.id,
    type: host.type,
    domainNames: host.domainNames,
    enabled: host.enabled,
    forwardHost: host.forwardHost,
    forwardPort: host.forwardPort,
    forwardScheme: host.forwardScheme ?? 'http',
    sslEnabled: host.sslEnabled,
    sslForced: host.sslForced,
    http2Support: host.http2Support,
    websocketSupport: host.websocketSupport,
    redirectUrl: host.redirectUrl,
    redirectStatusCode: host.redirectStatusCode ?? 301,
    customHeaders: (host.customHeaders ?? []) as { name: string; value: string }[],
    cacheEnabled: host.cacheEnabled,
    cacheOptions: host.cacheOptions as Record<string, unknown> | null,
    rateLimitEnabled: host.rateLimitEnabled,
    rateLimitMode: host.rateLimitMode,
    rateLimitOptions: host.rateLimitOptions as Record<string, unknown> | null,
    customRewrites: (host.customRewrites ?? []) as { source: string; destination: string; type: string }[],
    advancedConfig: includeAdvancedConfig ? host.advancedConfig : null,
    accessList: null, // simplified for preview
    sslCertPath: host.sslEnabled ? `/etc/nginx/certs/${host.id}.crt` : null,
    sslKeyPath: host.sslEnabled ? `/etc/nginx/certs/${host.id}.key` : null,
    sslChainPath: null,
  });
}

/** Render template content with sample data and run `nginx -t` on the first nginx node (test-only apply). */
export async function testTemplateContent(
  service: NginxTemplateService,
  nodeDispatch: NodeDispatchService,
  content: string
): Promise<{ rendered: string; valid: boolean; errors: string[] }> {
  const rendered = service.previewWithSampleData(content);
  try {
    const nodeId = await nodeDispatch.getFirstNginxNodeId();
    if (!nodeId) return { rendered, valid: false, errors: ['No nginx node available'] };
    // Send rendered config to daemon for test-only validation (writes temp, tests, removes)
    const testId = `test-${Date.now()}`;
    const result = await nodeDispatch.applyConfig(nodeId, testId, rendered, true);
    return { rendered, valid: result.success, errors: result.error ? [result.error] : [] };
  } catch (err) {
    return { rendered, valid: false, errors: [err instanceof Error ? err.message : 'Test failed'] };
  }
}
