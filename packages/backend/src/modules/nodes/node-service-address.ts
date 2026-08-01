import { isIP } from 'node:net';
import type { NodeHealthReport } from '@/db/schema/nodes.js';

const hostnameRegex =
  /^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$/;

export function isValidNodeServiceAddress(value: string): boolean {
  return isIP(value) !== 0 || hostnameRegex.test(value);
}

export function getEffectiveNodeServiceAddress(node: {
  serviceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string | null {
  const configured = node.serviceAddress?.trim();
  if (configured) return configured;
  return (
    node.lastHealthReport?.localIpAddresses?.find((address) => address.trim().length > 0) ??
    node.lastHealthReport?.publicIpAddresses?.find((address) => address.trim().length > 0) ??
    null
  );
}

/**
 * Returns the address exposed by a published managed database. When TLS is
 * enabled this must be an IP literal, because Gateway-issued database
 * certificates intentionally contain all reported node IP SANs, never an
 * arbitrary configured hostname.
 */
export function getEffectivePublishedNodeIP(node: {
  serviceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string | null {
  const configured = node.serviceAddress?.trim();
  if (configured && isIP(configured) !== 0) return configured;
  const candidates = [
    ...(node.lastHealthReport?.publicIpAddresses ?? []),
    ...(node.lastHealthReport?.localIpAddresses ?? []),
  ];
  return candidates.find((address) => isIP(address.trim()) !== 0) ?? null;
}
