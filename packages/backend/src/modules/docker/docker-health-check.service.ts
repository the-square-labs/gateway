import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerHealthEntry,
  type DockerHealthStatus,
  dockerAccessResources,
  dockerDeploymentRoutes,
  dockerDeployments,
  dockerHealthChecks,
  managedDatabaseBindings,
} from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerHealthCheckUpsertInput } from './docker.schemas.js';
import { DOCKER_DEPLOYMENT_MANAGED_LABEL } from './docker-deployment-labels.js';
import { DEFAULT_CONFIG, healthAction, normalizePath, parseDispatchResult } from './docker-health-check.helpers.js';

const logger = createChildLogger('DockerHealthCheckService');

export interface DockerHealthRouteOption {
  id: string;
  scheme: 'http' | 'https';
  hostPort: number;
  containerPort: number;
  label: string;
  isPrimary?: boolean;
}

export interface DockerHealthCheckDto {
  id: string | null;
  target: 'container' | 'deployment';
  nodeId: string;
  containerName: string | null;
  deploymentId: string | null;
  enabled: boolean;
  scheme: 'http' | 'https';
  hostPort: number | null;
  containerPort: number | null;
  path: string;
  statusMin: number;
  statusMax: number;
  expectedBody: string | null;
  bodyMatchMode: 'includes' | 'exact' | 'starts_with' | 'ends_with';
  intervalSeconds: number;
  timeoutSeconds: number;
  slowThreshold: number;
  healthStatus: DockerHealthStatus;
  lastHealthCheckAt: Date | null;
  healthHistory: DockerHealthEntry[];
  routeOptions: DockerHealthRouteOption[];
}

type HealthRow = typeof dockerHealthChecks.$inferSelect;

export class DockerHealthCheckService {
  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  private relayUnavailable = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: NodeDispatchService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('system.relay.health.changed', (payload) => {
      const state = (payload as { state?: unknown } | null)?.state;
      this.relayUnavailable = state === 'critical';
      void this.recheckBindingTargets();
    });
    bus.subscribe('database.changed', (payload) => {
      const event = payload as {
        resourceKind?: unknown;
        targetNodeId?: unknown;
        targetType?: unknown;
        targetResourceId?: unknown;
      } | null;
      if (
        event?.resourceKind !== 'managed_database_binding' ||
        typeof event.targetNodeId !== 'string' ||
        (event.targetType !== 'container' && event.targetType !== 'deployment') ||
        typeof event.targetResourceId !== 'string'
      ) {
        return;
      }
      void this.recheckTarget(event.targetNodeId, event.targetType, event.targetResourceId);
    });
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  async getContainer(nodeId: string, containerName: string): Promise<DockerHealthCheckDto> {
    const [row, options] = await Promise.all([
      this.db.query.dockerHealthChecks.findFirst({
        where: and(
          eq(dockerHealthChecks.target, 'container'),
          eq(dockerHealthChecks.nodeId, nodeId),
          eq(dockerHealthChecks.containerName, containerName)
        ),
      }),
      this.getContainerRouteOptions(nodeId, containerName),
    ]);
    return this.toDto(row ?? null, { target: 'container', nodeId, containerName, deploymentId: null }, options);
  }

  async getDeployment(nodeId: string, deploymentId: string): Promise<DockerHealthCheckDto> {
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)))
      .limit(1);
    if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');

    await this.ensureDeploymentDefault(nodeId, deploymentId);
    const [row, options] = await Promise.all([
      this.db.query.dockerHealthChecks.findFirst({
        where: and(eq(dockerHealthChecks.target, 'deployment'), eq(dockerHealthChecks.deploymentId, deploymentId)),
      }),
      this.getDeploymentRouteOptions(deploymentId),
    ]);
    return this.toDto(row ?? null, { target: 'deployment', nodeId, containerName: null, deploymentId }, options);
  }

  async upsertContainer(nodeId: string, containerName: string, input: DockerHealthCheckUpsertInput) {
    const routeOptions = await this.getContainerRouteOptions(nodeId, containerName);
    const values = this.normalizeInput(input, routeOptions, 'container');
    const [row] = await this.db
      .insert(dockerHealthChecks)
      .values({
        target: 'container',
        nodeId,
        containerName,
        deploymentId: null,
        ...values,
        healthStatus: values.enabled ? 'unknown' : 'disabled',
        healthHistory: [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [dockerHealthChecks.nodeId, dockerHealthChecks.containerName],
        set: { ...values, healthStatus: values.enabled ? 'unknown' : 'disabled', updatedAt: new Date() },
      })
      .returning();
    this.eventBus?.publish('docker.health.changed', {
      action: 'health.configured',
      target: 'container',
      nodeId,
      containerName,
      healthCheckId: row.id,
    });
    return this.toDto(row, { target: 'container', nodeId, containerName, deploymentId: null }, routeOptions);
  }

  async upsertDeployment(nodeId: string, deploymentId: string, input: DockerHealthCheckUpsertInput) {
    const deployment = await this.db.query.dockerDeployments.findFirst({
      where: and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)),
    });
    if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');

    const routeOptions = await this.getDeploymentRouteOptions(deploymentId);
    const values = this.normalizeInput(input, routeOptions, 'deployment');
    const [row] = await this.db
      .insert(dockerHealthChecks)
      .values({
        target: 'deployment',
        nodeId,
        containerName: null,
        deploymentId,
        ...values,
        healthStatus: values.enabled ? 'unknown' : 'disabled',
        healthHistory: [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: dockerHealthChecks.deploymentId,
        set: { ...values, healthStatus: values.enabled ? 'unknown' : 'disabled', updatedAt: new Date() },
      })
      .returning();
    await this.db
      .update(dockerDeployments)
      .set({
        healthConfig: {
          ...deployment.healthConfig,
          path: values.path,
          statusMin: values.statusMin,
          statusMax: values.statusMax,
          intervalSeconds: values.intervalSeconds,
          timeoutSeconds: values.timeoutSeconds,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)));
    if (values.hostPort && values.containerPort) {
      await this.db
        .update(dockerDeploymentRoutes)
        .set({ isPrimary: false })
        .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
      await this.db
        .update(dockerDeploymentRoutes)
        .set({ isPrimary: true })
        .where(
          and(
            eq(dockerDeploymentRoutes.deploymentId, deploymentId),
            eq(dockerDeploymentRoutes.hostPort, values.hostPort),
            eq(dockerDeploymentRoutes.containerPort, values.containerPort)
          )
        );
    }
    this.eventBus?.publish('docker.health.changed', {
      action: 'health.configured',
      target: 'deployment',
      nodeId,
      deploymentId,
      healthCheckId: row.id,
    });
    return this.toDto(row, { target: 'deployment', nodeId, containerName: null, deploymentId }, routeOptions);
  }

  async testContainer(nodeId: string, containerName: string, input?: DockerHealthCheckUpsertInput) {
    const current = await this.getContainer(nodeId, containerName);
    const config = input
      ? this.mergeDto(current, this.normalizeInput(input, current.routeOptions, 'container'))
      : current;
    return this.probeConfig(config, true);
  }

  async testDeployment(nodeId: string, deploymentId: string, input?: DockerHealthCheckUpsertInput) {
    const current = await this.getDeployment(nodeId, deploymentId);
    const config = input
      ? this.mergeDto(current, this.normalizeInput(input, current.routeOptions, 'deployment'))
      : current;
    return this.probeConfig(config, true);
  }

  async getRowsForContainers(nodeId: string, containerNames: string[]) {
    if (containerNames.length === 0) return new Map<string, HealthRow>();
    const rows = await this.db
      .select({
        id: dockerHealthChecks.id,
        target: dockerHealthChecks.target,
        nodeId: dockerHealthChecks.nodeId,
        containerName: dockerHealthChecks.containerName,
        deploymentId: dockerHealthChecks.deploymentId,
        enabled: dockerHealthChecks.enabled,
        healthStatus: dockerHealthChecks.healthStatus,
        lastHealthCheckAt: dockerHealthChecks.lastHealthCheckAt,
      })
      .from(dockerHealthChecks)
      .where(
        and(
          eq(dockerHealthChecks.target, 'container'),
          eq(dockerHealthChecks.nodeId, nodeId),
          inArray(dockerHealthChecks.containerName, containerNames)
        )
      );
    return new Map(rows.flatMap((row) => (row.containerName ? [[row.containerName, row] as const] : [])));
  }

  async listNavigationHealth() {
    const rows = await this.db
      .select({
        target: dockerHealthChecks.target,
        nodeId: dockerHealthChecks.nodeId,
        deploymentId: dockerHealthChecks.deploymentId,
        containerResourceId: dockerAccessResources.id,
        enabled: dockerHealthChecks.enabled,
        healthStatus: dockerHealthChecks.healthStatus,
      })
      .from(dockerHealthChecks)
      .leftJoin(
        dockerAccessResources,
        and(
          eq(dockerHealthChecks.target, 'container'),
          eq(dockerHealthChecks.nodeId, dockerAccessResources.nodeId),
          eq(dockerHealthChecks.containerName, dockerAccessResources.resourceKey)
        )
      )
      .where(eq(dockerHealthChecks.enabled, true));

    return rows.flatMap((row) => {
      const resourceId = row.target === 'deployment' ? row.deploymentId : row.containerResourceId;
      return resourceId
        ? [
            {
              nodeId: row.nodeId,
              resourceId,
              enabled: row.enabled,
              healthStatus: row.healthStatus,
            },
          ]
        : [];
    });
  }

  async getRowsForDeployments(deploymentIds: string[]) {
    if (deploymentIds.length === 0) return new Map<string, HealthRow>();
    const rows = await this.db
      .select({
        id: dockerHealthChecks.id,
        target: dockerHealthChecks.target,
        nodeId: dockerHealthChecks.nodeId,
        containerName: dockerHealthChecks.containerName,
        deploymentId: dockerHealthChecks.deploymentId,
        enabled: dockerHealthChecks.enabled,
        healthStatus: dockerHealthChecks.healthStatus,
        lastHealthCheckAt: dockerHealthChecks.lastHealthCheckAt,
      })
      .from(dockerHealthChecks)
      .where(and(eq(dockerHealthChecks.target, 'deployment'), inArray(dockerHealthChecks.deploymentId, deploymentIds)));
    return new Map(rows.flatMap((row) => (row.deploymentId ? [[row.deploymentId, row] as const] : [])));
  }

  async ensureDeploymentDefault(nodeId: string, deploymentId: string) {
    const [deployment] = await this.db
      .select({
        id: dockerDeployments.id,
        nodeId: dockerDeployments.nodeId,
        healthConfig: dockerDeployments.healthConfig,
      })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)))
      .limit(1);
    if (!deployment) return null;

    const routes = await this.db
      .select()
      .from(dockerDeploymentRoutes)
      .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
    const primary = routes.find((route) => route.isPrimary) ?? routes[0];
    if (!primary) return null;

    const [row] = await this.db
      .insert(dockerHealthChecks)
      .values({
        target: 'deployment',
        nodeId,
        deploymentId,
        enabled: true,
        scheme: 'http',
        hostPort: primary.hostPort,
        containerPort: primary.containerPort,
        path: deployment.healthConfig.path,
        statusMin: deployment.healthConfig.statusMin,
        statusMax: deployment.healthConfig.statusMax,
        intervalSeconds: Math.max(5, deployment.healthConfig.intervalSeconds),
        timeoutSeconds: deployment.healthConfig.timeoutSeconds,
        slowThreshold: 1000,
        healthStatus: 'unknown',
      })
      .onConflictDoNothing({ target: dockerHealthChecks.deploymentId })
      .returning();
    return row ?? null;
  }

  async alignDeploymentHealthCheck(nodeId: string, deploymentId: string) {
    await this.ensureDeploymentDefault(nodeId, deploymentId);
    const [row] = await this.db
      .select()
      .from(dockerHealthChecks)
      .where(and(eq(dockerHealthChecks.target, 'deployment'), eq(dockerHealthChecks.deploymentId, deploymentId)))
      .limit(1);
    if (!row) return;

    const [deployment, routes] = await Promise.all([
      this.db.query.dockerDeployments.findFirst({ where: eq(dockerDeployments.id, deploymentId) }),
      this.db.select().from(dockerDeploymentRoutes).where(eq(dockerDeploymentRoutes.deploymentId, deploymentId)),
    ]);
    if (!deployment || routes.length === 0) return;

    const selected =
      routes.find((route) => route.hostPort === row.hostPort && route.containerPort === row.containerPort) ??
      routes.find((route) => route.isPrimary) ??
      routes[0];
    await this.db
      .update(dockerHealthChecks)
      .set({
        hostPort: selected.hostPort,
        containerPort: selected.containerPort,
        path: deployment.healthConfig.path,
        statusMin: deployment.healthConfig.statusMin,
        statusMax: deployment.healthConfig.statusMax,
        intervalSeconds: Math.max(5, deployment.healthConfig.intervalSeconds),
        timeoutSeconds: deployment.healthConfig.timeoutSeconds,
        updatedAt: new Date(),
      })
      .where(eq(dockerHealthChecks.id, row.id));
  }

  async runDueChecks(now = new Date()) {
    const dueRows = await this.db
      .select()
      .from(dockerHealthChecks)
      .where(
        and(
          eq(dockerHealthChecks.enabled, true),
          or(
            sql`${dockerHealthChecks.lastHealthCheckAt} IS NULL`,
            lte(
              dockerHealthChecks.lastHealthCheckAt,
              sql`${now.toISOString()}::timestamptz - (${dockerHealthChecks.intervalSeconds} * interval '1 second')`
            )
          )
        )
      );
    if (dueRows.length === 0) return;

    const results = await Promise.allSettled(dueRows.map((row) => this.checkAndStore(row)));
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length > 0) {
      logger.warn('Some Docker health checks failed to execute', { errors: errors.length, total: dueRows.length });
    }
  }

  private async checkAndStore(row: HealthRow) {
    const previousStatus = row.healthStatus as DockerHealthStatus;
    const probe = await this.probeRow(row);
    const dependency = await this.databaseDependencyState(row);
    const status: DockerHealthStatus = dependency.offline ? 'offline' : probe.status;
    const entry: DockerHealthEntry = {
      ts: new Date().toISOString(),
      status,
      ...(probe.responseMs !== undefined ? { responseMs: probe.responseMs } : {}),
      ...(status === 'degraded' ? { slow: true } : {}),
    };
    const history = compactHealthHistory([...((row.healthHistory ?? []) as DockerHealthEntry[]), entry]);

    await this.db
      .update(dockerHealthChecks)
      .set({ healthStatus: status, lastHealthCheckAt: new Date(), healthHistory: history, updatedAt: new Date() })
      .where(eq(dockerHealthChecks.id, row.id));

    const resourceType = row.target === 'deployment' ? 'docker_deployment' : 'docker_container';
    const resourceId = row.target === 'deployment' ? row.deploymentId! : row.containerName!;
    const resourceName =
      row.target === 'deployment' ? await this.getDeploymentName(row.deploymentId!) : row.containerName!;
    if (dependency.cause !== 'relay_unavailable') {
      await this.evaluator?.observeStatefulEvent(
        'container',
        healthAction(status),
        { type: resourceType, id: resourceId, name: resourceName },
        {
          health_status: status,
          ...(dependency.cause ? { health_cause: dependency.cause } : {}),
          nodeId: row.nodeId,
          resource_type: resourceType,
        },
        ['health.online', 'health.degraded', 'health.offline']
      );
      if (dependency.hasBindings) {
        await this.evaluator?.observeStatefulEvent(
          'container',
          dependency.offline ? 'dependency.database_offline' : 'dependency.database_online',
          { type: resourceType, id: resourceId, name: resourceName },
          { health_status: status, health_cause: dependency.cause, nodeId: row.nodeId, resource_type: resourceType },
          ['dependency.database_offline']
        );
      }
    }

    if (previousStatus !== status) {
      this.eventBus?.publish('docker.health.changed', {
        action: healthAction(status),
        health_status: status,
        healthStatus: status,
        previousStatus,
        target: row.target,
        nodeId: row.nodeId,
        containerName: row.containerName,
        deploymentId: row.deploymentId,
        id: resourceId,
        name: resourceName,
        resourceType,
        health_cause: dependency.cause,
      });
    }
  }

  private async databaseDependencyState(row: HealthRow): Promise<{
    offline: boolean;
    cause: 'relay_unavailable' | 'binding_error' | null;
    hasBindings: boolean;
  }> {
    const targetResourceId = row.target === 'deployment' ? row.deploymentId : row.containerName;
    if (!targetResourceId || typeof (this.db as { select?: unknown }).select !== 'function') {
      return { offline: false, cause: null, hasBindings: false };
    }
    const bindings = await this.db
      .select({ status: managedDatabaseBindings.status })
      .from(managedDatabaseBindings)
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, row.nodeId),
          eq(managedDatabaseBindings.targetType, row.target),
          eq(managedDatabaseBindings.targetResourceId, targetResourceId)
        )
      );
    if (bindings.length === 0) return { offline: false, cause: null, hasBindings: false };
    if (this.relayUnavailable) return { offline: true, cause: 'relay_unavailable', hasBindings: true };
    if (bindings.some((binding) => binding.status === 'error')) {
      return { offline: true, cause: 'binding_error', hasBindings: true };
    }
    return { offline: false, cause: null, hasBindings: true };
  }

  private async recheckTarget(
    nodeId: string,
    target: 'container' | 'deployment' | 'compose_service',
    targetResourceId: string
  ): Promise<void> {
    if (target === 'compose_service') return;
    const row = await this.db.query.dockerHealthChecks.findFirst({
      where:
        target === 'deployment'
          ? and(
              eq(dockerHealthChecks.enabled, true),
              eq(dockerHealthChecks.target, 'deployment'),
              eq(dockerHealthChecks.nodeId, nodeId),
              eq(dockerHealthChecks.deploymentId, targetResourceId)
            )
          : and(
              eq(dockerHealthChecks.enabled, true),
              eq(dockerHealthChecks.target, 'container'),
              eq(dockerHealthChecks.nodeId, nodeId),
              eq(dockerHealthChecks.containerName, targetResourceId)
            ),
    });
    if (row) await this.checkAndStore(row);
  }

  private async recheckBindingTargets(): Promise<void> {
    const bindings = await this.db
      .select({
        nodeId: managedDatabaseBindings.targetNodeId,
        target: managedDatabaseBindings.targetType,
        resourceId: managedDatabaseBindings.targetResourceId,
      })
      .from(managedDatabaseBindings);
    const unique = new Map(
      bindings.map((binding) => [`${binding.nodeId}:${binding.target}:${binding.resourceId}`, binding])
    );
    await Promise.allSettled(
      [...unique.values()].map((binding) => this.recheckTarget(binding.nodeId, binding.target, binding.resourceId))
    );
  }

  private async getDeploymentName(deploymentId: string) {
    const row = await this.db.query.dockerDeployments.findFirst({ where: eq(dockerDeployments.id, deploymentId) });
    return row?.name ?? deploymentId;
  }

  private async probeRow(row: HealthRow) {
    const options =
      row.target === 'deployment' && row.deploymentId
        ? await this.getDeploymentRouteOptions(row.deploymentId)
        : row.containerName
          ? await this.getContainerRouteOptions(row.nodeId, row.containerName).catch(() => [])
          : [];
    const routeAvailable = options.some(
      (option) => option.hostPort === row.hostPort && option.containerPort === row.containerPort
    );
    if (!routeAvailable) return { ok: false, status: 'offline' as DockerHealthStatus };

    return this.probeConfig(
      this.toDto(
        row,
        {
          target: row.target,
          nodeId: row.nodeId,
          containerName: row.containerName,
          deploymentId: row.deploymentId,
        },
        options
      ),
      false
    );
  }

  private async probeConfig(config: DockerHealthCheckDto, requireEnabledRoute: boolean) {
    if (!config.enabled && requireEnabledRoute) {
      throw new AppError(400, 'HEALTH_CHECK_DISABLED', 'Enable the health check before testing it');
    }
    if (!config.hostPort || !config.containerPort) {
      throw new AppError(400, 'HEALTH_ROUTE_REQUIRED', 'Select a published HTTP route before testing health');
    }
    try {
      const result = await this.dispatch.sendDockerContainerCommand(
        config.nodeId,
        'http_probe',
        {
          configJson: JSON.stringify({
            scheme: config.scheme,
            hostPort: config.hostPort,
            path: normalizePath(config.path),
            statusMin: config.statusMin,
            statusMax: config.statusMax,
            expectedBody: config.expectedBody ?? '',
            bodyMatchMode: config.bodyMatchMode,
            timeoutSeconds: config.timeoutSeconds,
            slowThreshold: config.slowThreshold,
          }),
        },
        config.timeoutSeconds * 1000 + 5000
      );
      const probe = parseDispatchResult(result) as {
        ok?: boolean;
        status?: DockerHealthStatus;
        httpStatus?: number;
        responseMs?: number;
        error?: string;
      };
      return {
        ok: Boolean(probe?.ok),
        status: probe?.status ?? ('offline' as DockerHealthStatus),
        httpStatus: probe?.httpStatus,
        responseMs: probe?.responseMs,
      };
    } catch (error) {
      logger.debug('Docker health probe failed', {
        nodeId: config.nodeId,
        hostPort: config.hostPort,
        path: config.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, status: 'offline' as DockerHealthStatus };
    }
  }

  private normalizeInput(
    input: DockerHealthCheckUpsertInput,
    options: DockerHealthRouteOption[],
    target: 'container' | 'deployment'
  ) {
    const hostPort = input.hostPort ?? null;
    const containerPort = input.containerPort ?? null;
    if (input.enabled && (!hostPort || !containerPort)) {
      throw new AppError(400, 'HEALTH_ROUTE_REQUIRED', 'Select a published HTTP route before enabling health checks');
    }
    if (hostPort && containerPort) {
      const found = options.some((option) => option.hostPort === hostPort && option.containerPort === containerPort);
      if (!found) {
        throw new AppError(
          400,
          'HEALTH_ROUTE_INVALID',
          target === 'deployment'
            ? 'Selected route is not configured for this deployment'
            : 'Selected route is not a published port on this container'
        );
      }
    }
    return {
      enabled: input.enabled,
      scheme: input.scheme,
      hostPort,
      containerPort,
      path: normalizePath(input.path),
      statusMin: input.statusMin,
      statusMax: input.statusMax,
      expectedBody: input.expectedBody?.trim() ? input.expectedBody : null,
      bodyMatchMode: input.bodyMatchMode,
      intervalSeconds: input.intervalSeconds,
      timeoutSeconds: input.timeoutSeconds,
      slowThreshold: input.slowThreshold,
    };
  }

  private mergeDto(
    current: DockerHealthCheckDto,
    input: ReturnType<DockerHealthCheckService['normalizeInput']>
  ): DockerHealthCheckDto {
    return {
      ...current,
      ...input,
      healthStatus: current.healthStatus,
      healthHistory: current.healthHistory,
      lastHealthCheckAt: current.lastHealthCheckAt,
      routeOptions: current.routeOptions,
    };
  }

  private toDto(
    row: HealthRow | null,
    identity: {
      target: 'container' | 'deployment';
      nodeId: string;
      containerName: string | null;
      deploymentId: string | null;
    },
    routeOptions: DockerHealthRouteOption[]
  ): DockerHealthCheckDto {
    const source = row ?? DEFAULT_CONFIG;
    return {
      id: row?.id ?? null,
      target: identity.target,
      nodeId: identity.nodeId,
      containerName: identity.containerName,
      deploymentId: identity.deploymentId,
      enabled: source.enabled,
      scheme: source.scheme,
      hostPort: source.hostPort,
      containerPort: source.containerPort,
      path: source.path,
      statusMin: source.statusMin,
      statusMax: source.statusMax,
      expectedBody: source.expectedBody,
      bodyMatchMode: source.bodyMatchMode,
      intervalSeconds: source.intervalSeconds,
      timeoutSeconds: source.timeoutSeconds,
      slowThreshold: source.slowThreshold,
      healthStatus: row?.healthStatus ?? (source.enabled ? 'unknown' : 'disabled'),
      lastHealthCheckAt: source.lastHealthCheckAt,
      healthHistory: source.healthHistory ?? [],
      routeOptions,
    };
  }

  private async getContainerRouteOptions(nodeId: string, containerName: string): Promise<DockerHealthRouteOption[]> {
    const result = await this.dispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId: containerName });
    if (!result.success) throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Could not inspect container');
    const inspect = result.detail ? JSON.parse(result.detail) : null;
    const labels = inspect?.Config?.Labels ?? {};
    if (labels[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true') {
      throw new AppError(
        409,
        'MANAGED_DEPLOYMENT_CONTAINER',
        'This container is managed by a blue/green deployment. Use deployment settings instead.'
      );
    }
    const bindings = (inspect?.HostConfig?.PortBindings ?? {}) as Record<
      string,
      Array<{ HostPort?: string; HostIp?: string }> | null
    >;
    return Object.entries(bindings).flatMap(([privatePort, published]) => {
      if (!published) return [];
      const [containerPortRaw, proto] = privatePort.split('/');
      if (proto && proto !== 'tcp') return [];
      const containerPort = Number(containerPortRaw);
      return published.flatMap((binding) => {
        const hostPort = Number(binding.HostPort);
        if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort)) return [];
        return [
          {
            id: `${hostPort}:${containerPort}`,
            scheme: 'http' as const,
            hostPort,
            containerPort,
            label: `${hostPort} -> ${containerPort}`,
          },
        ];
      });
    });
  }

  private async getDeploymentRouteOptions(deploymentId: string): Promise<DockerHealthRouteOption[]> {
    const routes = await this.db
      .select()
      .from(dockerDeploymentRoutes)
      .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
    return routes.map((route) => ({
      id: `${route.hostPort}:${route.containerPort}`,
      scheme: 'http' as const,
      hostPort: route.hostPort,
      containerPort: route.containerPort,
      label: `${route.hostPort} -> ${route.containerPort}`,
      isPrimary: route.isPrimary,
    }));
  }
}
