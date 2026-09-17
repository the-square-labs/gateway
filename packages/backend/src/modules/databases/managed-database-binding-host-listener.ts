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
export declare function managedDatabaseBindingListenerConfig(args: {
  networkName: string;
  gatewayAddress: string | undefined;
  listenPort: number;
  allowedSources: string[];
}): ManagedDatabaseBindingListenerConfig;
export declare function requireManagedDatabaseBindingListenerReady(
  result: CommandResult,
  bindingId: string,
  expectedAddress: string
): void;
