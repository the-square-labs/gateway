import { AppError } from '@/middleware/error-handler.js';

/**
 * Host console and host file access can be turned off in a node's daemon config file (`console.enabled`,
 * `files.enabled`). The switch lives only on the node, so nobody can turn it back on from the Gateway; the daemon
 * advertises a disabled feature with these markers when it registers. Docker container consoles and container files
 * are not covered: they give no host access.
 */
export const NODE_CONSOLE_DISABLED_CAPABILITY = 'node_console_disabled_v1';
export const NODE_FILES_DISABLED_CAPABILITY = 'node_files_disabled_v1';
/**
 * The daemon config sets `console.user` to another user, but the daemon runs without root and cannot start sessions
 * as that user, so it refuses every console session.
 */
export const NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY = 'node_console_user_unavailable_v1';

const CONSOLE_USER_UNAVAILABLE = {
  code: 'NODE_CONSOLE_USER_UNAVAILABLE',
  message:
    "This node's daemon config sets console.user to another user, but the daemon does not run as root and cannot start sessions as that user. Remove console.user from the daemon config file on the node, or run the daemon as root, and restart the daemon.",
};

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
  nodeConsoleUserUnavailable?: true;
} {
  return {
    ...(advertised?.includes(NODE_CONSOLE_DISABLED_CAPABILITY) ? { nodeConsoleDisabled: true as const } : {}),
    ...(advertised?.includes(NODE_FILES_DISABLED_CAPABILITY) ? { nodeFilesDisabled: true as const } : {}),
    ...(advertised?.includes(NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY)
      ? { nodeConsoleUserUnavailable: true as const }
      : {}),
  };
}

export function nodeHostFeatureDisabledError(feature: NodeHostFeature): AppError {
  const { code, message } = FEATURES[feature];
  return new AppError(409, code, message);
}

type CapabilityRegistry = { hasCapability(nodeId: string, capability: string): boolean };

/** Why the node's daemon refuses every host console session, or null when it accepts them. */
export function nodeConsoleRefusal(registry: CapabilityRegistry, nodeId: string): AppError | null {
  if (registry.hasCapability(nodeId, NODE_CONSOLE_DISABLED_CAPABILITY)) {
    return nodeHostFeatureDisabledError('console');
  }
  if (registry.hasCapability(nodeId, NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY)) {
    return new AppError(409, CONSOLE_USER_UNAVAILABLE.code, CONSOLE_USER_UNAVAILABLE.message);
  }
  return null;
}

/** Refuses a host console or file command for a connected node whose daemon advertises the feature as unavailable. */
export function assertNodeHostFeatureEnabled(
  registry: CapabilityRegistry,
  nodeId: string,
  feature: NodeHostFeature
): void {
  const refusal =
    feature === 'console'
      ? nodeConsoleRefusal(registry, nodeId)
      : registry.hasCapability(nodeId, FEATURES[feature].capability)
        ? nodeHostFeatureDisabledError(feature)
        : null;
  if (refusal) {
    throw refusal;
  }
}
