import { randomUUID } from 'node:crypto';
import type { ServerDuplexStream } from '@grpc/grpc-js';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import type { NodeHealthReport, NodeStatsReport } from '@/db/schema/nodes.js';
import type { CommandResult, DaemonMessage, GatewayCommand } from '@/grpc/generated/types.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import type { DockerRuntimeStatus } from '@/modules/docker/docker.schemas.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('NodeRegistry');

function closeStream(stream: { end?: () => void; destroy?: () => void } | null | undefined): void {
  if (!stream) return;
  try {
    stream.end?.();
  } catch {
    /* ignore */
  }
  try {
    stream.destroy?.();
  } catch {
    /* ignore */
  }
}

export interface ConnectedNode {
  connectionId: string;
  nodeId: string;
  type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'databases';
  hostname: string;
  commandStream: ServerDuplexStream<DaemonMessage, GatewayCommand>;
  logStream: ServerDuplexStream<unknown, unknown> | null;
  connectedAt: Date;
  lastHealthReport: NodeHealthReport | null;
  lastReportAt: Date | null;
  lastStatsReport: NodeStatsReport | null;
  lastTrafficStats: Record<string, unknown> | null;
  configVersionHash: string;
  pendingCommands: Map<
    string,
    {
      resolve: (result: CommandResult) => void;
      reject: (error: Error) => void;
      resolveAccepted: () => void;
      rejectAccepted: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
}

export interface DispatchedCommand {
  accepted: Promise<void>;
  result: Promise<CommandResult>;
}

export class NodeRegistryService {
  private nodes = new Map<string, ConnectedNode>();
  private execOutputHandlers = new Map<
    string,
    Set<(data: { execId: string; data: Buffer; exited: boolean; exitCode: number }) => void>
  >();
  private logStreamHandlers = new Map<string, (lines: string[], ended?: boolean) => void>();

  constructor(private db: DrizzleClient) {}

  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  private observeNodeState(nodeId: string, state: 'online' | 'offline', hostname?: string) {
    this.evaluator
      ?.observeStatefulEvent('node', state, { type: 'node', id: nodeId, name: hostname ?? nodeId }, { hostname })
      .catch((error) => {
        logger.debug('Node stateful event observation failed', {
          nodeId,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  observeDockerContainerState(nodeId: string, id: string, name?: string, state?: string) {
    const normalizedState = this.normalizeDockerContainerState(state);
    if (!normalizedState) return;

    const resourceId = name || id;
    const observedPatterns =
      normalizedState === 'started' || normalizedState === 'removed' ? ['stopped', 'exited'] : [normalizedState];

    this.evaluator
      ?.observeStatefulEvent(
        'container',
        normalizedState,
        { type: 'container', id: resourceId, name: name ?? id },
        { nodeId, containerId: id, state },
        observedPatterns
      )
      .catch((error) => {
        logger.debug('Docker container stateful event observation failed', {
          nodeId,
          containerId: id,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private normalizeDockerContainerState(state?: string): 'started' | 'stopped' | 'exited' | 'removed' | null {
    switch (state?.toLowerCase()) {
      case 'running':
        return 'started';
      case 'stopped':
        return 'stopped';
      case 'exited':
      case 'dead':
        return 'exited';
      case 'removed':
        return 'removed';
      default:
        return null;
    }
  }

  publishNodeChanged(nodeId: string, status: string, hostname?: string) {
    this.eventBus?.publish('node.changed', { id: nodeId, action: 'updated', status, hostname });
  }

  publishDockerRuntimeChanged(nodeId: string, status: DockerRuntimeStatus) {
    this.eventBus?.publish('docker.runtime.changed', { nodeId, status });
  }

  publishDockerContainerChanged(
    nodeId: string,
    id: string,
    name?: string,
    state?: string,
    options: { observe?: boolean } = {}
  ) {
    this.eventBus?.publish('docker.container.changed', {
      nodeId,
      id,
      name,
      action: 'updated',
      state,
    });
    if (options.observe !== false) {
      this.observeDockerContainerState(nodeId, id, name, state);
    }
  }

  registerExecHandler(execId: string, handler: (data: any) => void) {
    let handlers = this.execOutputHandlers.get(execId);
    if (!handlers) {
      handlers = new Set();
      this.execOutputHandlers.set(execId, handlers);
    }
    handlers.add(handler);
  }

  removeExecHandler(execId: string, handler?: (data: any) => void) {
    if (handler) {
      const handlers = this.execOutputHandlers.get(execId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) this.execOutputHandlers.delete(execId);
      }
    } else {
      this.execOutputHandlers.delete(execId);
    }
  }

  getExecHandlerCount(execId: string): number {
    return this.execOutputHandlers.get(execId)?.size ?? 0;
  }

  handleExecOutput(execId: string, data: any) {
    const handlers = this.execOutputHandlers.get(execId);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
  }

  registerLogStreamHandler(key: string, handler: (lines: string[], ended?: boolean) => void) {
    this.logStreamHandlers.set(key, handler);
  }

  removeLogStreamHandler(key: string) {
    this.logStreamHandlers.delete(key);
  }

  handleLogStream(key: string, lines: string[], ended?: boolean) {
    const handler = this.logStreamHandlers.get(key);
    if (handler) handler(lines, ended);
  }

  async register(
    nodeId: string,
    type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'databases',
    hostname: string,
    configVersionHash: string,
    commandStream: ServerDuplexStream<DaemonMessage, GatewayCommand>,
    options: { isCurrentRegistration?: () => boolean } = {}
  ): Promise<void> {
    const connectionId = randomUUID();

    if (options.isCurrentRegistration && !options.isCurrentRegistration()) {
      throw new Error('Registration superseded');
    }

    await this.db
      .update(nodes)
      .set({
        status: 'online',
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, nodeId));

    if (options.isCurrentRegistration && !options.isCurrentRegistration()) {
      throw new Error('Registration superseded');
    }

    // Replace stale/overlapping connection for the same node ID.
    const existing = this.nodes.get(nodeId);
    if (existing) {
      logger.warn('Replacing existing daemon connection for node', { nodeId, hostname });
      this.cleanupPendingCommands(existing);
      closeStream(existing.logStream as any);
      closeStream(existing.commandStream as any);
    }

    this.nodes.set(nodeId, {
      connectionId,
      nodeId,
      type,
      hostname,
      commandStream,
      logStream: null,
      connectedAt: new Date(),
      lastHealthReport: null,
      lastReportAt: null,
      lastStatsReport: null,
      lastTrafficStats: null,
      configVersionHash,
      pendingCommands: new Map(),
    });

    logger.info('Node registered', { nodeId, type, hostname });
    this.observeNodeState(nodeId, 'online', hostname);
  }

  async deregister(nodeId: string, commandStream?: ServerDuplexStream<DaemonMessage, GatewayCommand>): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return; // Already removed
    if (commandStream && node.commandStream !== commandStream) {
      logger.debug('Ignoring stale deregister for replaced node stream', { nodeId });
      return;
    }

    this.cleanupPendingCommands(node);
    this.nodes.delete(nodeId);

    await this.db
      .update(nodes)
      .set({
        status: 'offline',
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, nodeId));

    // Record unhealthy hour in health history so the health bar shows the offline state
    await this.recordOfflineStatus(nodeId);

    logger.info('Node deregistered', { nodeId });
    this.eventBus?.publish('node.changed', {
      id: nodeId,
      action: 'updated',
      status: 'offline',
      hostname: node.hostname,
    });
    this.observeNodeState(nodeId, 'offline', node.hostname);
  }

  getNode(nodeId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodes(): ConnectedNode[] {
    return Array.from(this.nodes.values());
  }

  getNodesByType(type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'databases'): ConnectedNode[] {
    return this.getAllNodes().filter((n) => n.type === type);
  }

  getConnectedNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  async sendCommand(nodeId: string, command: Partial<GatewayCommand>, timeoutMs = 30000): Promise<CommandResult> {
    const dispatched = this.dispatchCommand(nodeId, command, timeoutMs);
    void dispatched.accepted.catch(() => {});
    return dispatched.result;
  }

  dispatchCommand(nodeId: string, command: Partial<GatewayCommand>, timeoutMs = 30000): DispatchedCommand {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const commandId = randomUUID();
    const fullCommand: GatewayCommand = {
      commandId,
      ...command,
    };

    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });

    const result = new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        node.pendingCommands.delete(commandId);
        const error = new Error(`Command ${commandId} timed out after ${timeoutMs}ms`);
        rejectAccepted(error);
        reject(error);
      }, timeoutMs);

      node.pendingCommands.set(commandId, {
        resolve,
        reject,
        resolveAccepted,
        rejectAccepted,
        timeout,
      });

      node.commandStream.write(fullCommand, (err: Error | null | undefined) => {
        if (err) {
          clearTimeout(timeout);
          node.pendingCommands.delete(commandId);
          const error = new Error(`Failed to send command: ${err.message}`);
          rejectAccepted(error);
          reject(error);
          return;
        }
        resolveAccepted();
      });
    });

    return { accepted, result };
  }

  /** Fire-and-forget: write a command to the stream without awaiting a response */
  sendCommandNoWait(nodeId: string, command: Partial<GatewayCommand>): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const fullCommand: GatewayCommand = {
      commandId: '',
      ...command,
    };

    node.commandStream.write(fullCommand, (err: Error | null | undefined) => {
      if (err) {
        logger.debug('Fire-and-forget write failed', { nodeId, error: err.message });
      }
    });
  }

  handleCommandResult(nodeId: string, result: CommandResult): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const pending = node.pendingCommands.get(result.commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      node.pendingCommands.delete(result.commandId);
      pending.resolveAccepted();
      pending.resolve(result);
    }
  }

  updateHealthReport(nodeId: string, report: NodeHealthReport): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      const previousIngressAddresses = [
        ...(node.lastHealthReport?.localIpAddresses ?? []),
        ...(node.lastHealthReport?.publicIpAddresses ?? []),
      ]
        .map((address) => address.trim())
        .filter(Boolean)
        .sort();
      const nextIngressAddresses = [...(report.localIpAddresses ?? []), ...(report.publicIpAddresses ?? [])]
        .map((address) => address.trim())
        .filter(Boolean)
        .sort();
      node.lastHealthReport = report;
      node.lastReportAt = new Date();
      if (node.type === 'nginx' && previousIngressAddresses.join('\u0000') !== nextIngressAddresses.join('\u0000')) {
        this.eventBus?.publish('node.ingress_addresses.changed', { id: nodeId });
      }
    }
  }

  updateStatsReport(nodeId: string, report: NodeStatsReport): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.lastStatsReport = report;
    }
  }

  async updateLastSeen(nodeId: string): Promise<void> {
    await this.db
      .update(nodes)
      .set({
        lastSeenAt: new Date(),
      })
      .where(eq(nodes.id, nodeId));
  }

  /** Mark nodes as offline if they haven't been seen recently */
  async markStaleNodesOffline(staleThresholdMs = 90000): Promise<void> {
    const now = Date.now();
    const connectedIds = this.getConnectedNodeIds();

    // For nodes that are in the DB as 'online' but not in our connected set
    // This handles ungraceful disconnects that the gRPC layer didn't catch
    const dbOnlineNodes = await this.db
      .select({ id: nodes.id, hostname: nodes.hostname, lastSeenAt: nodes.lastSeenAt })
      .from(nodes)
      .where(eq(nodes.status, 'online'));

    for (const dbNode of dbOnlineNodes) {
      if (!connectedIds.includes(dbNode.id)) {
        const lastSeen = dbNode.lastSeenAt?.getTime() ?? 0;
        if (now - lastSeen > staleThresholdMs) {
          await this.db
            .update(nodes)
            .set({
              status: 'offline',
              updatedAt: new Date(),
            })
            .where(eq(nodes.id, dbNode.id));
          await this.recordOfflineStatus(dbNode.id);
          logger.warn('Marked stale node as offline', { nodeId: dbNode.id });
          this.eventBus?.publish('node.changed', {
            id: dbNode.id,
            action: 'updated',
            status: 'offline',
            hostname: dbNode.hostname,
          });
          this.observeNodeState(dbNode.id, 'offline', dbNode.hostname ?? undefined);
        }
      }
    }
  }

  /** Record ongoing offline entries for disconnected nodes + detect missed reports from connected ones */
  async recordHealthChecks(missedThresholdMs = 60000): Promise<void> {
    const now = Date.now();

    // 1. Connected nodes that stopped sending reports — mark offline and notify
    for (const node of this.nodes.values()) {
      if (!node.lastReportAt) continue;
      const elapsed = now - node.lastReportAt.getTime();
      if (elapsed > missedThresholdMs) {
        await this.recordOfflineStatus(node.nodeId);

        // Update DB status and publish event (only once per transition)
        const [dbRow] = await this.db
          .select({ status: nodes.status })
          .from(nodes)
          .where(eq(nodes.id, node.nodeId))
          .limit(1);
        if (dbRow?.status === 'online') {
          await this.db
            .update(nodes)
            .set({ status: 'offline', updatedAt: new Date() })
            .where(eq(nodes.id, node.nodeId));
          this.eventBus?.publish('node.changed', {
            id: node.nodeId,
            action: 'updated',
            status: 'offline',
            hostname: node.hostname,
          });
          this.observeNodeState(node.nodeId, 'offline', node.hostname);
          logger.warn('Marked connected node offline (missed health reports)', {
            nodeId: node.nodeId,
            elapsedMs: elapsed,
          });
        } else if (dbRow?.status === 'offline') {
          this.observeNodeState(node.nodeId, 'offline', node.hostname);
        }
      }
    }

    // 2. Disconnected nodes — keep recording offline entries (same as proxy health check job)
    const connectedIds = this.getConnectedNodeIds();
    const offlineNodes = await this.db
      .select({ id: nodes.id, hostname: nodes.hostname })
      .from(nodes)
      .where(eq(nodes.status, 'offline'));

    for (const dbNode of offlineNodes) {
      if (!connectedIds.includes(dbNode.id)) {
        await this.recordOfflineStatus(dbNode.id);
        this.observeNodeState(dbNode.id, 'offline', dbNode.hostname ?? undefined);
      }
    }
  }

  /** Record an offline entry in health history (same format as proxy health checks) */
  private async recordOfflineStatus(nodeId: string): Promise<void> {
    try {
      const nowMs = Date.now();
      const [row] = await this.db
        .select({ healthHistory: nodes.healthHistory })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);

      const history = compactHealthHistory(
        [
          ...((row?.healthHistory as Array<{ ts: string; status: string }>) ?? []),
          { ts: new Date(nowMs).toISOString(), status: 'offline' },
        ],
        { nowMs }
      );

      await this.db.update(nodes).set({ healthHistory: history }).where(eq(nodes.id, nodeId));
    } catch (err) {
      logger.warn('Failed to record offline status', { nodeId, error: (err as Error).message });
    }
  }

  private cleanupPendingCommands(node: ConnectedNode): void {
    for (const [id, pending] of node.pendingCommands) {
      clearTimeout(pending.timeout);
      const error = new Error('Node disconnected');
      pending.rejectAccepted(error);
      pending.reject(error);
      node.pendingCommands.delete(id);
    }
  }
}
