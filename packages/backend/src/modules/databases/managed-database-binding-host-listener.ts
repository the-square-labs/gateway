import { isIP } from 'node:net';

interface CommandResult {
  success: boolean;
  detail?: string;
  error?: string;
}

export interface ManagedDatabaseBindingListenerConfig {
  networkName: string;
  listenAddress: string;
  listenPort: number;
  allowedSources: string[];
}

export function managedDatabaseBindingListenerConfig(args: {
  networkName: string;
  gatewayAddress: string | undefined;
  listenPort: number;
  allowedSources: string[];
}): ManagedDatabaseBindingListenerConfig {
  if (!args.gatewayAddress || isIP(args.gatewayAddress) !== 4) {
    throw new Error(`managed database network ${args.networkName} has no valid IPv4 gateway`);
  }
  return {
    networkName: args.networkName,
    listenAddress: args.gatewayAddress,
    listenPort: args.listenPort,
    allowedSources: [...new Set(args.allowedSources)].sort(),
  };
}

export function requireManagedDatabaseBindingListenerReady(
  result: CommandResult,
  bindingId: string,
  expectedAddress: string
): void {
  if (!result.success) throw new Error(result.error || 'managed database listener grant sync failed');
  let status: { address?: unknown; state?: unknown; error?: unknown } | undefined;
  try {
    status = JSON.parse(result.detail ?? '').listenerStatuses?.[bindingId];
  } catch {
    throw new Error('managed database listener returned invalid status details');
  }
  if (status?.state !== 'ready' || status.address !== expectedAddress) {
    const detail = typeof status?.error === 'string' && status.error ? `: ${status.error}` : '';
    throw new Error(`managed database listener is not ready${detail}`);
  }
}
