import type { NodeIngressHealth } from '@/db/schema/nodes.js';

/**
 * The ingress health an nginx daemon reports (HealthReport.ingress_health, sf-ingress). It is what the daemon's
 * reserved health endpoint `/.well-known/gateway-ingress-health` answers at that moment: serving only while nginx
 * runs the config generation the daemon applied last and, for a node with Secure Link sources, at least one relay
 * transport is usable. DNS failover (Cloudflare monitors, the DNS steward) probes the endpoint itself; Gateway shows
 * the reported copy per ingress group member.
 */
export type IngressHealthReport = NodeIngressHealth;

/** The reserved path every Gateway-rendered server block and every node's default servers answer. */
export const INGRESS_HEALTH_PATH = '/.well-known/gateway-ingress-health';
/** Unix socket of the nginx daemon's health responder that the reserved location proxies to. */
export const INGRESS_HEALTH_SOCKET = '/run/gateway-ingress-health/health.sock';
/** Host name the daemon-managed health server answers on :80 and :443 (with a self-signed certificate). */
export const INGRESS_HEALTH_HOSTNAME = 'ingress-health.gateway.invalid';

function toNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** Maps the proto message (proto-loader keeps camelCase, int64 as strings) to the stored health report field. */
export function ingressHealthFromProto(raw: unknown): { ingressHealth?: IngressHealthReport } {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const checkedAtMs = toNumber(value.checkedAtUnixMs);
  return {
    ingressHealth: {
      serving: value.serving === true,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : '',
      configGeneration: toNumber(value.configGeneration),
      nginxRunning: value.nginxRunning === true,
      configApplied: value.configApplied === true,
      secureLinkSources: toNumber(value.secureLinkSources),
      usableRelayTransports: toNumber(value.usableRelayTransports),
      checkedAt: checkedAtMs > 0 ? new Date(checkedAtMs).toISOString() : null,
    },
  };
}

/** The stored copy from a node's last health report, if its daemon reports one. */
export function ingressHealthOf(lastHealthReport: unknown): IngressHealthReport | null {
  const report = (lastHealthReport as { ingressHealth?: IngressHealthReport } | null | undefined)?.ingressHealth;
  return report && typeof report === 'object' ? report : null;
}

/** Header nginx adds with the config generation of the configuration that handled the probe. */
export const INGRESS_GENERATION_HEADER = 'X-Gateway-Ingress-Generation';

/**
 * The reserved location every Gateway-rendered server block gets on a node that advertises ingress_group_v1. Kept
 * byte-identical with nginx.IngressHealthLocation() in the nginx daemon (the daemon renders it into its own servers).
 * The exact-match location wins over every other location of the block; access lists and basic auth do not apply.
 */
export const INGRESS_HEALTH_LOCATION = `    location = ${INGRESS_HEALTH_PATH} {
        access_log off;
        allow all;
        auth_basic off;
        default_type application/json;
        add_header Cache-Control "no-store" always;
        proxy_pass http://unix:${INGRESS_HEALTH_SOCKET}:/health;
        proxy_set_header Host $host;
        proxy_set_header ${INGRESS_GENERATION_HEADER} $gateway_ingress_generation;
        proxy_connect_timeout 2s;
        proxy_send_timeout 3s;
        proxy_read_timeout 3s;
    }
`;

/** Adds the reserved health location to every server block of a rendered config (once). */
export function withIngressHealthLocation(rendered: string): string {
  if (rendered.includes(`location = ${INGRESS_HEALTH_PATH} {`)) return rendered;
  return rendered.replace(/^[\t ]*server[\t ]*\{/gm, (match) => `${match}\n${INGRESS_HEALTH_LOCATION}`);
}
