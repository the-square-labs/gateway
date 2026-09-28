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
