import { AppError } from '@/middleware/error-handler.js';

/**
 * Host console and host file access can be turned off in a node's daemon config file (`console.enabled`,
 * `files.enabled`). The switch lives only on the node, so nobody can turn it back on from the Gateway; the daemon
 * advertises a disabled feature with these markers when it registers. Docker container consoles and container files
 * are not covered: they give no host access.
 */
export const NODE_CONSOLE_DISABLED_CAPABILITY = 'node_console_disabled_v1';
export const NODE_FILES_DISABLED_CAPABILITY = 'node_files_disabled_v1';

export type NodeHostFeature = 'console' | 'files';

const FEATURES: Record<NodeHostFeature, { capability: string; code: string; message: string }> = {
  console: {
    capability: NODE_CONSOLE_DISABLED_CAPABILITY,
    code: 'NODE_CONSOLE_DISABLED',
    message:
      "Console is disabled in this node's daemon configuration. Set console.enabled: true in the daemon config file on the node and restart the daemon to enable it.",
  },
  files: {
    capability: NODE_FILES_DISABLED_CAPABILITY,
    code: 'NODE_FILES_DISABLED',
    message:
      "File access is disabled in this node's daemon configuration. Set files.enabled: true in the daemon config file on the node and restart the daemon to enable it.",
  },
};

/** The flags stored on the node's capabilities (and returned by the node API) for the features its daemon disabled. */
export function nodeHostAccessFlags(advertised: readonly string[] | null | undefined): {
  nodeConsoleDisabled?: true;
  nodeFilesDisabled?: true;
} {
  return {
    ...(advertised?.includes(NODE_CONSOLE_DISABLED_CAPABILITY) ? { nodeConsoleDisabled: true as const } : {}),
    ...(advertised?.includes(NODE_FILES_DISABLED_CAPABILITY) ? { nodeFilesDisabled: true as const } : {}),
  };
}

export function nodeHostFeatureDisabledError(feature: NodeHostFeature): AppError {
  const { code, message } = FEATURES[feature];
  return new AppError(409, code, message);
}

/** Refuses a host console or file command for a connected node whose daemon advertises the feature as disabled. */
export function assertNodeHostFeatureEnabled(
  registry: { hasCapability(nodeId: string, capability: string): boolean },
  nodeId: string,
  feature: NodeHostFeature
): void {
  if (registry.hasCapability(nodeId, FEATURES[feature].capability)) {
    throw nodeHostFeatureDisabledError(feature);
  }
}
