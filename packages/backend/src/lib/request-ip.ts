import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { container } from '@/container.js';
import { ipInAnyCidr, normalizeIp } from '@/lib/ip-cidr.js';
import {
  DEFAULT_NETWORK_SECURITY_SETTINGS,
  type NetworkSecuritySettings,
  NetworkSettingsService,
} from '@/modules/settings/network-settings.service.js';
import type { AppEnv } from '@/types.js';

const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export interface ClientIpResolution {
  ipAddress?: string;
  remoteAddress?: string;
  source: 'remote' | 'cloudflare' | 'forwarded' | 'real-ip' | 'unknown';
  warning?: string;
}

export function resolveClientIp(
  headers: Pick<Headers, 'get'>,
  remoteAddress: string | undefined,
  settings: NetworkSecuritySettings = DEFAULT_NETWORK_SECURITY_SETTINGS
): ClientIpResolution {
  const remote = normalizeIp(remoteAddress);
  const cfIp = normalizeIp(headers.get('cf-connecting-ip'));
  const xRealIp = normalizeIp(headers.get('x-real-ip'));
  const forwardedIp = clientFromForwardedFor(headers.get('x-forwarded-for'), settings.trustedProxyCidrs);
  const remoteIsTrustedProxy = remote ? ipInAnyCidr(remote, settings.trustedProxyCidrs) : false;
  const remoteIsCloudflare = remote ? ipInAnyCidr(remote, CLOUDFLARE_CIDRS) : false;
  const configuredProxyRequired = settings.trustedProxyCidrs.length > 0;
  const explicitProxyTrusted = configuredProxyRequired ? remoteIsTrustedProxy : true;

  if (settings.clientIpSource === 'direct') {
    return remote
      ? { ipAddress: remote, remoteAddress: remote, source: 'remote' }
      : { remoteAddress: remote, source: 'unknown' };
  }

  if (settings.clientIpSource === 'cloudflare') {
    if (cfIp && (settings.trustCloudflareHeaders || remoteIsCloudflare || remoteIsTrustedProxy)) {
      return { ipAddress: cfIp, remoteAddress: remote, source: 'cloudflare' };
    }
    return fallbackRemote(
      remote,
      cfIp || forwardedIp || xRealIp ? 'Cloudflare headers are present but not trusted for this request' : undefined
    );
  }

  if (settings.clientIpSource === 'reverse_proxy') {
    if (xRealIp && explicitProxyTrusted) {
      return { ipAddress: xRealIp, remoteAddress: remote, source: 'real-ip' };
    }
    if (forwardedIp && explicitProxyTrusted) {
      return { ipAddress: forwardedIp, remoteAddress: remote, source: 'forwarded' };
    }
    return fallbackRemote(
      remote,
      forwardedIp || xRealIp ? 'Forwarded headers are present but not trusted for this request' : undefined
    );
  }

  if (cfIp && (remoteIsCloudflare || settings.trustCloudflareHeaders)) {
    return { ipAddress: cfIp, remoteAddress: remote, source: 'cloudflare' };
  }
  if (xRealIp && remoteIsTrustedProxy) {
    return { ipAddress: xRealIp, remoteAddress: remote, source: 'real-ip' };
  }
  if (forwardedIp && remoteIsTrustedProxy) {
    return { ipAddress: forwardedIp, remoteAddress: remote, source: 'forwarded' };
  }

  return fallbackRemote(
    remote,
    forwardedIp || xRealIp || cfIp ? 'Proxy headers are present but ignored in auto mode' : undefined
  );
}

export async function resolveClientIpForContext(c: Context<AppEnv>): Promise<ClientIpResolution> {
  const settings = await getNetworkSettings();
  return resolveClientIp(c.req.raw.headers, getRemoteAddress(c), settings);
}

export async function getClientIpForContext(c: Context<AppEnv>): Promise<string | undefined> {
  return (await resolveClientIpForContext(c)).ipAddress;
}

export function getRemoteAddress(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

async function getNetworkSettings(): Promise<NetworkSecuritySettings> {
  try {
    return await container.resolve(NetworkSettingsService).getConfig();
  } catch {
    return DEFAULT_NETWORK_SECURITY_SETTINGS;
  }
}

function fallbackRemote(remote: string | undefined, warning?: string): ClientIpResolution {
  return remote
    ? { ipAddress: remote, remoteAddress: remote, source: 'remote', warning }
    : { source: 'unknown', warning };
}

/**
 * Each proxy appends the peer it saw, so only the right end of X-Forwarded-For is
 * trustworthy. Walk from the right past our own trusted proxies and take the first
 * hop they did not vouch for; anything further left is client-controlled.
 */
function clientFromForwardedFor(value: string | null, trustedProxyCidrs: string[]): string | undefined {
  const hops = (value?.split(',') ?? [])
    .map((part) => normalizeIp(part.trim()))
    .filter((part): part is string => Boolean(part));
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = hops[index]!;
    if (trustedProxyCidrs.length === 0 || !ipInAnyCidr(hop, trustedProxyCidrs)) return hop;
  }
  return hops[0];
}
