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
const TRAFFIC_STATS_CACHE_TTL_MS = 60_000;
const TRAFFIC_STATS_CACHE_MAX_ENTRIES = 4_096;

function hasUpdateInProgress(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata as Record<string, unknown>;
  if (value.updateInProgress !== true) return false;
  if (typeof value.updateDeadlineAt !== 'string') return true;
  const deadlineAt = Date.parse(value.updateDeadlineAt);
  return !Number.isFinite(deadlineAt) || Date.now() < deadlineAt;
}

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
  type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'builder' | 'databases' | 'relay';
  hostname: string;
  commandStream: ServerDuplexStream<DaemonMessage, GatewayCommand>;
  logStream: ServerDuplexStream<unknown, unknown> | null;
  connectedAt: Date;
  lastHealthReport: NodeHealthReport | null;
  lastReportAt: Date | null;
  lastStatsReport: NodeStatsReport | null;
  lastTrafficStats: Record<string, unknown> | null;
  configVersionHash: string;
  capabilities: ReadonlySet<string>;
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

export interface TrafficStatsRequest {
  tailLines: number;
  hostId: string;
  windowSeconds: number;
}

export class NodeRegistryService {
  private nodes = new Map<string, ConnectedNode>();
  private updatingNodeIds = new Set<string>();
  private execOutputHandlers = new Map<
    string,
    Set<(data: { execId: string; data: Buffer; exited: boolean; exitCode: number }) => void>
  >();
  private logStreamHandlers = new Map<string, (lines: string[], ended?: boolean) => void>();
  private trafficStatsInFlight = new Map<string, Promise<CommandResult>>();
  private trafficStatsNodeTails = new Map<string, Promise<void>>();
  private trafficStatsCache = new Map<string, { sampledAt: number; result: CommandResult }>();

  constructor(private db: DrizzleClient) {}

  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  setNodeUpdateInProgress(nodeId: string, updating: boolean): void {
    if (updating) this.updatingNodeIds.add(nodeId);
    else this.updatingNodeIds.delete(nodeId);
  }

  isNodeUpdateInProgress(nodeId: string): boolean {
    return this.updatingNodeIds.has(nodeId);
  }

  private isNodeUpdateProtected(nodeId: string, metadata: unknown): boolean {
    if (metadata && typeof metadata === 'object') {
      const protectedByMetadata = hasUpdateInProgress(metadata);
      if (protectedByMetadata) this.updatingNodeIds.add(nodeId);
      else this.updatingNodeIds.delete(nodeId);
      return protectedByMetadata;
    }
    return this.isNodeUpdateInProgress(nodeId);
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
    type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'builder' | 'databases' | 'relay',
    hostname: string,
    configVersionHash: string,
    commandStream: ServerDuplexStream<DaemonMessage, GatewayCommand>,
    options: { isCurrentRegistration?: () => boolean; capabilities?: string[] } = {}
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

    const [registeredNode] = await this.db
      .select({ metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    this.setNodeUpdateInProgress(nodeId, hasUpdateInProgress(registeredNode?.metadata));

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

    this.clearTrafficStatsState(nodeId);

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
      capabilities: new Set(options.capabilities ?? []),
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
    this.clearTrafficStatsState(nodeId);

    const [dbNode] = await this.db
      .select({ metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (this.isNodeUpdateProtected(nodeId, dbNode?.metadata)) {
      this.updatingNodeIds.add(nodeId);
      logger.info('Node disconnected for daemon update; preserving status', { nodeId });
      return;
    }

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

  hasCapability(nodeId: string, capability: string): boolean {
    return this.nodes.get(nodeId)?.capabilities.has(capability) ?? false;
  }

  getAllNodes(): ConnectedNode[] {
    return Array.from(this.nodes.values());
  }

  getNodesByType(type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'databases' | 'relay'): ConnectedNode[] {
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

  /**
   * Coalesces equivalent traffic samples and serializes access-log scans per
   * nginx node. The cache is last-good only: failed samples never replace it.
   */
  requestTrafficStats(nodeId: string, request: TrafficStatsRequest, minFreshMs = 0): Promise<CommandResult> {
    const connectionId = this.nodes.get(nodeId)?.connectionId;
    if (!connectionId) return Promise.reject(new Error(`Node ${nodeId} is not connected`));
    const key = `${nodeId}\u0000${request.hostId}\u0000${request.tailLines}\u0000${request.windowSeconds}`;
    this.pruneTrafficStatsCache(Date.now());
    const cached = this.trafficStatsCache.get(key);
    if (cached && minFreshMs > 0 && Date.now() - cached.sampledAt < minFreshMs) {
      return Promise.resolve(cached.result);
    }

    const active = this.trafficStatsInFlight.get(key);
    if (active) return active;

    const previous = this.trafficStatsNodeTails.get(nodeId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => {
        if (this.nodes.get(nodeId)?.connectionId !== connectionId) {
          throw new Error(`Node ${nodeId} connection changed before traffic stats request`);
        }
        return this.sendCommand(nodeId, { requestTrafficStats: request }, 10_000);
      })
      .then((result) => {
        if (result.success) {
          const sampledAt = Date.now();
          this.trafficStatsCache.set(key, { sampledAt, result });
          this.pruneTrafficStatsCache(sampledAt);
          if (!request.hostId && result.detail) {
            try {
              const node = this.nodes.get(nodeId);
              if (node) node.lastTrafficStats = JSON.parse(result.detail);
            } catch {
              // Keep the previous last-good node snapshot on malformed output.
            }
          }
        }
        return result;
      })
      .finally(() => {
        if (this.trafficStatsInFlight.get(key) === task) this.trafficStatsInFlight.delete(key);
      });
    this.trafficStatsInFlight.set(key, task);

    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.trafficStatsNodeTails.set(nodeId, tail);
    void tail.then(() => {
      if (this.trafficStatsNodeTails.get(nodeId) === tail) this.trafficStatsNodeTails.delete(nodeId);
    });
    return task;
  }

  private pruneTrafficStatsCache(now: number): void {
    for (const [key, cached] of this.trafficStatsCache) {
      if (now - cached.sampledAt >= TRAFFIC_STATS_CACHE_TTL_MS) this.trafficStatsCache.delete(key);
    }
    if (this.trafficStatsCache.size <= TRAFFIC_STATS_CACHE_MAX_ENTRIES) return;
    const overflow = this.trafficStatsCache.size - TRAFFIC_STATS_CACHE_MAX_ENTRIES;
    const oldestKeys = [...this.trafficStatsCache.entries()]
      .sort((left, right) => left[1].sampledAt - right[1].sampledAt)
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldestKeys) this.trafficStatsCache.delete(key);
  }

  private clearTrafficStatsState(nodeId: string): void {
    const prefix = `${nodeId}\u0000`;
    for (const key of this.trafficStatsCache.keys()) {
      if (key.startsWith(prefix)) this.trafficStatsCache.delete(key);
    }
    for (const key of this.trafficStatsInFlight.keys()) {
      if (key.startsWith(prefix)) this.trafficStatsInFlight.delete(key);
    }
    this.trafficStatsNodeTails.delete(nodeId);
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
      .select({ id: nodes.id, hostname: nodes.hostname, lastSeenAt: nodes.lastSeenAt, metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.status, 'online'));

    for (const dbNode of dbOnlineNodes) {
      if (this.isNodeUpdateProtected(dbNode.id, dbNode.metadata)) continue;
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
        // Update DB status and publish event (only once per transition)
        const [dbRow] = await this.db
          .select({ status: nodes.status, metadata: nodes.metadata })
          .from(nodes)
          .where(eq(nodes.id, node.nodeId))
          .limit(1);
        if (this.isNodeUpdateProtected(node.nodeId, dbRow?.metadata)) continue;

        await this.recordOfflineStatus(node.nodeId);
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
      .select({ id: nodes.id, hostname: nodes.hostname, metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.status, 'offline'));

    for (const dbNode of offlineNodes) {
      if (this.isNodeUpdateProtected(dbNode.id, dbNode.metadata)) continue;
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
