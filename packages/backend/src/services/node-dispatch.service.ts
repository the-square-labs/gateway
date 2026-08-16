import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DaemonUpdateService } from './daemon-update.service.js';
import type { DispatchedCommand, NodeRegistryService } from './node-registry.service.js';
import type { RelayGrantBundle } from './relay-policy.service.js';

const logger = createChildLogger('NodeDispatch');

// The database daemon caps its operation and rollback at 14 minutes. Keep this
// controller deadline slightly longer so it always receives the final result
// instead of marking an operation failed while it still changes disk state.
const managedDatabaseCommandTimeoutMs = 15 * 60 * 1000;
// SelfUpdate can spend up to five minutes downloading the binary before it
// acknowledges the command. Leave a small margin for verification and replace.
const daemonUpdateCommandTimeoutMs = 5 * 60 * 1000 + 30_000;

export class NodeDispatchService {
  private daemonUpdateService?: DaemonUpdateService;

  constructor(
    private registry: NodeRegistryService,
    private db: DrizzleClient
  ) {}

  setDaemonUpdateService(service: DaemonUpdateService) {
    this.daemonUpdateService = service;
  }

  isNodeConnected(nodeId: string | null): boolean {
    return !!nodeId && !!this.registry.getNode(nodeId);
  }

  private async assertNodeMutable(nodeId: string) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(nodeId))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }
  }

  /** Database-profile docker daemons are not general workload nodes. */
  private async assertGenericDockerNode(nodeId: string) {
    const [node] = await this.db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (node.type !== 'docker') {
      throw new AppError(409, 'NODE_TYPE_MISMATCH', 'Generic Docker operations require a Docker node');
    }
  }

  private async assertDatabaseNode(nodeId: string) {
    const [node] = await this.db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (node.type !== 'databases') {
      throw new AppError(409, 'NODE_TYPE_MISMATCH', 'Managed database operations require a databases node');
    }
  }

  async applyConfig(
    nodeId: string,
    hostId: string,
    configContent: string,
    testOnly = false,
    configOwnership = ''
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      applyConfig: { hostId, configContent, testOnly, configOwnership },
    });
  }

  async removeConfig(nodeId: string, hostId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeConfig: { hostId },
    });
  }

  async deployCertificate(
    nodeId: string,
    certId: string,
    certPem: Buffer,
    keyPem: Buffer,
    chainPem?: Buffer
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      deployCert: {
        certId,
        certPem,
        keyPem,
        chainPem: chainPem ?? Buffer.alloc(0),
      },
    });
  }

  async removeCertificate(nodeId: string, certId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeCert: { certId },
    });
  }

  async applyTlsBundle(
    nodeId: string,
    input: {
      hostId: string;
      configContent: string;
      generation: string;
      configOwnership?: string;
      certificates: Array<{
        certId: string;
        certPem: Buffer;
        keyPem: Buffer;
        chainPem: Buffer;
        version: string;
        replicaGeneration: string;
      }>;
    }
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        applyTlsBundle: {
          hostId: input.hostId,
          configContent: input.configContent,
          generation: input.generation,
          configOwnership: input.configOwnership ?? '',
          certificates: input.certificates,
        },
      },
      60_000
    );
  }

  async inspectCertificates(nodeId: string, certIds: string[]): Promise<CommandResult> {
    return this.registry.sendCommand(nodeId, { inspectCertificates: { certIds } }, 30_000);
  }

  async exportLegacyCertificates(nodeId: string, certIds: string[]): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, { exportLegacyCertificates: { certIds } }, 60_000);
  }

  async removeCertificateReplica(
    nodeId: string,
    certId: string,
    expectedVersion: string,
    expectedReplicaGeneration: string
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { removeCertificateReplica: { certId, expectedVersion, expectedReplicaGeneration } },
      30_000
    );
  }

  async deployHtpasswd(nodeId: string, accessListId: string, content: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      deployHtpasswd: { accessListId, content },
    });
  }

  async removeHtpasswd(nodeId: string, accessListId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeHtpasswd: { accessListId },
    });
  }

  async updateGlobalConfig(nodeId: string, content: string, backupContent: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      updateGlobalConfig: { content, backupContent },
    });
  }

  async testConfig(nodeId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        testConfig: {},
      },
      10000
    );
  }

  async requestHealth(nodeId: string): Promise<CommandResult> {
    return this.registry.sendCommand(
      nodeId,
      {
        requestHealth: {},
      },
      10000
    );
  }

  async requestStats(nodeId: string): Promise<CommandResult> {
    return this.registry.sendCommand(
      nodeId,
      {
        requestStats: {},
      },
      10000
    );
  }

  async deployAcmeChallenge(nodeId: string, token: string, content: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      deployAcmeChallenge: { token, content },
    });
  }

  async removeAcmeChallenge(nodeId: string, token: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeAcmeChallenge: { token },
    });
  }

  async readGlobalConfig(nodeId: string): Promise<CommandResult> {
    return this.registry.sendCommand(nodeId, { readGlobalConfig: {} }, 10000);
  }

  async requestTrafficStats(
    nodeId: string,
    tailLines = 200,
    options: { hostId?: string; windowSeconds?: number } = {}
  ): Promise<CommandResult> {
    return this.registry.sendCommand(
      nodeId,
      {
        requestTrafficStats: {
          tailLines,
          hostId: options.hostId ?? '',
          windowSeconds: options.windowSeconds ?? 0,
        },
      },
      10000
    );
  }

  async setDaemonLogStream(nodeId: string, enabled: boolean, minLevel = 'info', tailLines = 0): Promise<CommandResult> {
    return this.registry.sendCommand(nodeId, {
      setDaemonLogStream: { enabled, minLevel, tailLines },
    });
  }

  /** Send a pre-built FullSyncCommand to a node */
  async fullSync(
    nodeId: string,
    hosts: { hostId: string; configContent: string; configOwnership?: string }[],
    certs: { certId: string; certPem: Buffer; keyPem: Buffer; chainPem: Buffer }[],
    globalConfig: string,
    htpasswdFiles: { accessListId: string; content: string }[],
    versionHash: string
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    logger.info('Sending full sync', { nodeId, hostCount: hosts.length, certCount: certs.length });
    return this.registry.sendCommand(
      nodeId,
      {
        fullSync: {
          hosts: hosts.map((h) => ({
            hostId: h.hostId,
            configContent: h.configContent,
            configOwnership: h.configOwnership ?? '',
          })),
          certs: certs.map((c) => ({ certId: c.certId, certPem: c.certPem, keyPem: c.keyPem, chainPem: c.chainPem })),
          globalConfig,
          htpasswdFiles: htpasswdFiles.map((h) => ({ accessListId: h.accessListId, content: h.content })),
          versionHash,
        },
      },
      60000 // 60s timeout for full sync
    );
  }

  // ─── Docker Commands ──────────────────────────────────────────────

  async sendDockerMigrationCommand(
    nodeId: string,
    action: string,
    options: {
      migrationId?: string;
      artifactId?: string;
      artifactType?: string;
      resourceId?: string;
      configJson?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerMigration: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  /**
   * Send a restricted managed-database lifecycle command. This is a separate
   * proto command so a database node never receives arbitrary Docker commands.
   */
  async sendDockerDatabaseCommand(
    nodeId: string,
    action: string,
    managedDatabaseId: string,
    configJson = '',
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertDatabaseNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { dockerDatabase: { action, managedDatabaseId, configJson } as any },
      timeoutMs ?? managedDatabaseCommandTimeoutMs
    );
  }

  async sendManagedDatabaseLogsCommand(
    nodeId: string,
    managedDatabaseId: string,
    options: {
      tailLines?: number;
      follow?: boolean;
      timestamps?: boolean;
      since?: string;
      until?: string;
    } = {}
  ): Promise<CommandResult> {
    await this.assertDatabaseNode(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerDatabase: {
        action: 'logs',
        managedDatabaseId,
        configJson: JSON.stringify(options),
      } as any,
    });
  }

  async stopManagedDatabaseLogStream(nodeId: string, managedDatabaseId: string): Promise<CommandResult> {
    await this.assertDatabaseNode(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerDatabase: { action: 'logs_stop', managedDatabaseId, configJson: '{}' } as any,
    });
  }

  async sendRelayGrantBundle(nodeId: string, bundle: RelayGrantBundle, timeoutMs = 30_000): Promise<CommandResult> {
    await this.assertGenericRelayNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        syncRelayGrants: {
          policyRevision: bundle.revision,
          generatedAtUnixMs: bundle.generatedAtUnixMs,
          dataLanes: bundle.dataLanes ?? 4,
          readChunkBytes: bundle.readChunkBytes ?? 32 * 1024,
          grants: bundle.grants.map((assignment) => ({
            role: assignment.role,
            ownerKind: assignment.ownerKind,
            ownerId: assignment.ownerId,
            endpointId: assignment.endpointId,
            routeId: assignment.routeId,
            targetEndpointId: assignment.targetEndpointId,
            grant: assignment.grant,
          })),
        },
      },
      timeoutMs
    );
  }

  async sendProxySecureLinks(
    nodeId: string,
    bindings: Array<{
      linkId: string;
      role: 'source' | 'target';
      generation: number;
      listenerPort?: number;
      targetNetwork?: string;
      targetContainer?: string;
      targetHost?: string;
      targetPort?: number;
      connectorImage?: string;
      allowNetworkReselection?: boolean;
    }>,
    timeoutMs = 60_000
  ): Promise<CommandResult> {
    await this.assertProxySecureLinkNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        syncProxySecureLinks: {
          bindings: bindings.map((binding) => ({ ...binding, generation: String(binding.generation) })),
        },
      },
      timeoutMs
    );
  }

  async probeProxySecureLink(
    nodeId: string,
    input: {
      linkId: string;
      scheme: 'http' | 'https';
      path: string;
      expectedStatus?: number | null;
      expectedBody?: string | null;
      bodyMatchMode?: string | null;
      timeoutSeconds?: number;
    }
  ): Promise<{ ok: boolean; httpStatus?: number; responseMs?: number; error?: string }> {
    await this.assertProxySecureLinkNode(nodeId);
    const result = await this.registry.sendCommand(
      nodeId,
      {
        probeProxySecureLink: {
          linkId: input.linkId,
          scheme: input.scheme,
          path: input.path,
          expectedStatus: input.expectedStatus ?? 0,
          expectedBody: input.expectedBody ?? '',
          bodyMatchMode: input.bodyMatchMode ?? 'includes',
          timeoutSeconds: input.timeoutSeconds ?? 10,
        },
      },
      ((input.timeoutSeconds ?? 10) + 5) * 1000
    );
    if (!result.success) return { ok: false, error: result.error || 'Secure Link probe failed' };
    try {
      return JSON.parse(result.detail || '{}') as { ok: boolean; httpStatus?: number; responseMs?: number };
    } catch {
      return { ok: false, error: 'Nginx daemon returned an invalid Secure Link probe result' };
    }
  }

  private async assertProxySecureLinkNode(nodeId: string) {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes('proxy_secure_links_v1')) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before creating this Docker proxy link'
      );
    }
  }

  private async assertGenericRelayNode(nodeId: string) {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes('generic_relay_tunnel_v1')) {
      throw new AppError(409, 'NODE_CAPABILITY_MISMATCH', 'Node daemon does not support generic relay grants');
    }
  }

  async sendDockerContainerCommand(
    nodeId: string,
    action: string,
    options: {
      containerId?: string;
      configJson?: string;
      timeoutSeconds?: number;
      signal?: string;
      newName?: string;
      force?: boolean;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (!['list', 'inspect', 'stats', 'top', 'http_probe', 'task_status'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        dockerContainer: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerImageCommand(
    nodeId: string,
    action: string,
    options: {
      imageRef?: string;
      registryAuthJson?: string;
      force?: boolean;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action !== 'list') {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        dockerImage: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerVolumeCommand(
    nodeId: string,
    action: string,
    options: {
      name?: string;
      labels?: Record<string, string>;
      force?: boolean;
      path?: string;
      maxBytes?: number;
      newName?: string;
      content?: string | Buffer;
      targetPath?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (!['list', 'inspect'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    const payload = {
      ...options,
      content: typeof options.content === 'string' ? Buffer.from(options.content) : options.content,
    };
    return this.registry.sendCommand(
      nodeId,
      {
        dockerVolume: { action, ...payload } as any,
      },
      timeoutMs
    );
  }

  async sendDockerRuntimeCommand(
    nodeId: string,
    action: 'preflight' | 'install',
    timeoutMs = action === 'install' ? 30 * 60 * 1000 : 2 * 60 * 1000
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action === 'install') await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, { dockerRuntime: { action, runtime: 'runsc' } as any }, timeoutMs);
  }

  async sendDockerNetworkCommand(
    nodeId: string,
    action: string,
    options: {
      networkId?: string;
      containerId?: string;
      driver?: string;
      subnet?: string;
      gatewayAddr?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action !== 'list') {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        dockerNetwork: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerDeploymentCommand(
    nodeId: string,
    action: string,
    options: {
      deploymentId?: string;
      slot?: string;
      configJson?: string;
      force?: boolean;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action !== 'inspect') {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        dockerDeployment: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerExecCommand(
    nodeId: string,
    action: string,
    options: {
      containerId?: string;
      command?: string[];
      tty?: boolean;
      stdin?: boolean;
      rows?: number;
      cols?: number;
      user?: string;
      sessionKey?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerExec: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendNodeExecCommand(
    nodeId: string,
    action: string,
    options: {
      command?: string[];
      tty?: boolean;
      rows?: number;
      cols?: number;
      sessionKey?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        nodeExec: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendNodeFileCommand(
    nodeId: string,
    action: string,
    options: {
      path?: string;
      targetPath?: string;
      maxBytes?: number;
      content?: string | Buffer;
    } = {}
  ): Promise<CommandResult> {
    if (!['list', 'read'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    const { content, ...rest } = options;
    const payload: Record<string, unknown> = { action, ...rest };
    if (Buffer.isBuffer(content)) {
      payload.content = content;
    } else if (content != null) {
      payload.content = Buffer.from(content);
    }
    return this.registry.sendCommand(nodeId, {
      nodeFile: payload as any,
    });
  }

  async sendDockerFileCommand(
    nodeId: string,
    action: string,
    options: {
      containerId?: string;
      path?: string;
      targetPath?: string;
      maxBytes?: number;
      content?: string | Buffer;
    } = {}
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (!['list', 'read'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    const { content, ...rest } = options;
    const payload: Record<string, unknown> = { action, ...rest };
    if (Buffer.isBuffer(content)) {
      payload.content = content;
    } else if (content != null) {
      payload.content = Buffer.from(content);
    }
    return this.registry.sendCommand(nodeId, {
      dockerFile: payload as any,
    });
  }

  async sendDockerLogsCommand(
    nodeId: string,
    containerId: string,
    options: {
      tailLines?: number;
      follow?: boolean;
      timestamps?: boolean;
      since?: string;
      until?: string;
    } = {}
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerLogs: { containerId, ...options } as any,
    });
  }

  async sendDockerConfigPush(
    nodeId: string,
    registries: Array<{ url: string; username: string; password: string }>,
    allowlist: string[]
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerConfigPush: { registries, allowlist },
    });
  }

  /** Fire-and-forget exec input (no response expected) */
  sendExecInput(nodeId: string, execId: string, data: Buffer): void {
    try {
      this.registry.sendCommandNoWait(nodeId, {
        execInput: { execId, data },
      });
    } catch {
      /* ignore */
    }
  }

  /** Get the default nginx node ID, or null if none configured */
  /** Get the first online nginx node ID, or null if none available */
  async getFirstNginxNodeId(): Promise<string | null> {
    const [node] = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'nginx'), eq(nodes.status, 'online')))
      .limit(1);
    return node?.id ?? null;
  }

  /** Resolve the node ID for a proxy host, falling back to default node */
  async sendUpdateDaemonCommand(
    nodeId: string,
    downloadUrl: string,
    targetVersion: string,
    checksum: string,
    signedManifest: string
  ): Promise<DispatchedCommand> {
    if (!this.registry.getNode(nodeId)) {
      throw new AppError(409, 'NODE_NOT_CONNECTED', 'Node is not connected');
    }
    return this.registry.dispatchCommand(
      nodeId,
      { updateDaemon: { downloadUrl, targetVersion, checksum, signedManifest } },
      daemonUpdateCommandTimeoutMs
    );
  }

  async resolveNodeId(proxyHostNodeId: string | null): Promise<string> {
    if (proxyHostNodeId) return proxyHostNodeId;
    throw new Error('No node assigned to this proxy host');
  }
}
