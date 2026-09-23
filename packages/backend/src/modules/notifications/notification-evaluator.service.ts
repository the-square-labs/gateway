import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  databaseConnections,
  loggingEnvironments,
  nodes,
  notificationAlertRules,
  notificationAlertStates,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { HostingAccountObservation } from '@/modules/hosting/hosting-observations.service.js';
import type { CacheService, RedisClient } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  EVENT_BUS_MAPPINGS,
  evaluateThreshold,
  evaluateWindowRatio,
  eventSupportsThreshold,
  extractMetricFromDatabaseSnapshot,
  extractMetricFromHealthReport,
  isPerDeviceNodeMetric,
  type Severity,
  type WindowProbeSample,
} from './notification.constants.js';
import type { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import type { NotificationDispatcherService } from './notification-dispatcher.service.js';
import {
  buildNotificationTemplateContext,
  type NotificationEvent,
  type NotificationTemplateContextInput,
  type NotificationTemplateResource,
  renderTemplate,
} from './notification-templates.js';
import type { NotificationWebhookService } from './notification-webhook.service.js';

const logger = createChildLogger('NotificationEvaluator');

const METRIC_BUFFER_TTL = 1800;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGGING_RATIO_SAMPLING_MS = 5 * 60 * 1000;
const STATE_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const STATE_MAINTENANCE_DEBOUNCE_MS = 2_000;
const RESOLVED_STATE_RETENTION_MS = 30 * DAY_MS;
const RESOLVED_STATE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const HOSTING_CATEGORIES = new Set(['hosting_account', 'hosting_vm']);
/** Rule fields that decide which resources/metric a firing state belongs to. */
const RULE_SOURCE_KEYS = ['type', 'category', 'metric', 'metricTarget', 'eventPattern'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AlertStateRow = typeof notificationAlertStates.$inferSelect;
type ResourceKind = 'node' | 'proxy' | 'certificate' | 'database' | 'logging';

type TemplateDetails = Partial<
  Pick<
    NotificationTemplateContextInput,
    | 'metric'
    | 'node'
    | 'health'
    | 'certificate'
    | 'state'
    | 'event'
    | 'operation'
    | 'failure'
    | 'details'
    | 'fired'
    | 'resolution'
  >
> & { resourceId?: string | null };

export class NotificationEvaluatorService {
  private eventBus?: EventBusService;
  private redis: RedisClient | null = null;
  private loggingEnvironmentService?: {
    list(): Promise<Array<{ id: string; name: string; enabled: boolean }>>;
  };
  private loggingClickHouseService?: {
    getFacets(
      environmentId: string,
      range?: { from?: string; to?: string }
    ): Promise<{ severities: Array<{ severity: string; count: number }> }>;
  };
  private unsubscribers: Array<() => void> = [];
  private readonly activeHandlers = new Set<Promise<void>>();
  private readonly activeDeliveries = new Set<Promise<void>>();
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private maintenanceDebounce: ReturnType<typeof setTimeout> | null = null;
  private maintenanceRun: Promise<void> | null = null;
  private lastResolvedStatePrune = 0;
  private readonly hostingEventChains = new Map<string, Promise<void>>();
  private hostingRuleBarrier: Promise<void> = Promise.resolve();

  private thresholdRulesCache: any[] = [];
  private eventRulesCache: any[] = [];
  private lastRuleCacheRefresh = 0;
  private readonly RULE_CACHE_TTL = 30_000;

  constructor(
    private db: DrizzleClient,
    private ruleService: NotificationAlertRuleService,
    private webhookService: NotificationWebhookService,
    private dispatcherService: NotificationDispatcherService,
    cacheService: CacheService | null,
    private nodeRegistry: NodeRegistryService
  ) {
    this.redis = cacheService?.getClient() ?? null;
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setLoggingServices(
    environmentService: { list(): Promise<Array<{ id: string; name: string; enabled: boolean }>> },
    clickHouseService: {
      getFacets(
        environmentId: string,
        range?: { from?: string; to?: string }
      ): Promise<{ severities: Array<{ severity: string; count: number }> }>;
    }
  ): void {
    this.loggingEnvironmentService = environmentService;
    this.loggingClickHouseService = clickHouseService;
  }

  start(): void {
    if (!this.eventBus) {
      logger.warn('EventBus not set, evaluator will not process events');
      return;
    }

    for (const channel of Object.keys(EVENT_BUS_MAPPINGS)) {
      const unsub = this.eventBus.subscribe(channel, (payload: unknown) => {
        const hosting = channel.startsWith('hosting.')
          ? (payload as { resourceId?: string; connectorId?: string; nodeId?: string; id?: string })
          : null;
        const key = hosting ? (hosting.resourceId ?? hosting.nodeId ?? hosting.connectorId ?? hosting.id) : undefined;
        const ruleBarrier = this.hostingRuleBarrier;
        // One resource's observations must retain order while asynchronous delivery is in flight.
        const work = key
          ? (this.hostingEventChains.get(key) ?? Promise.resolve()).then(async () => {
              await ruleBarrier;
              await this.handleBusEvent(channel, payload);
            })
          : this.handleBusEvent(channel, payload);
        const active = work
          .catch((err) => {
            logger.error('Error handling event', { channel, error: err instanceof Error ? err.message : String(err) });
          })
          .finally(() => {
            this.activeHandlers.delete(active);
            if (key && this.hostingEventChains.get(key) === active) this.hostingEventChains.delete(key);
          });
        if (key) this.hostingEventChains.set(key, active);
        this.activeHandlers.add(active);
      });
      this.unsubscribers.push(unsub);
    }

    // Rule edits from any surface (UI, API, AI, MCP) publish this; clean up states they orphaned.
    this.unsubscribers.push(
      this.eventBus.subscribe('notification.alert-rule.changed', () => this.scheduleStateMaintenance())
    );
    this.maintenanceInterval = setInterval(() => void this.runStateMaintenance(), STATE_MAINTENANCE_INTERVAL_MS);
    this.maintenanceInterval.unref?.();

    logger.info('Notification evaluator started', { channels: Object.keys(EVENT_BUS_MAPPINGS).length });
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
    if (this.maintenanceDebounce) clearTimeout(this.maintenanceDebounce);
    this.maintenanceInterval = null;
    this.maintenanceDebounce = null;
    await Promise.allSettled([...this.activeHandlers, ...(this.maintenanceRun ? [this.maintenanceRun] : [])]);
    // Queued deliveries are durable; waiting only lets in-flight sends record their outcome.
    await Promise.allSettled([...this.activeDeliveries]);
  }

  // ── Health Report Evaluation ────────────────────────────────────────

  async evaluateHealthReport(nodeId: string, healthData: any): Promise<void> {
    const rules = await this.getThresholdRules();
    if (rules.length === 0) return;

    for (const rule of rules) {
      // Only evaluate rules matching the node category or container category
      if (rule.category !== 'node' && rule.category !== 'container') continue;

      // Check resource scope for node rules
      if (rule.category === 'node' && rule.resourceIds?.length > 0) {
        if (!rule.resourceIds.includes(nodeId)) {
          logger.debug('Skipping rule: node not in scope', { ruleId: rule.id, nodeId, scopedIds: rule.resourceIds });
          continue;
        }
      }

      const extraction = extractMetricFromHealthReport(rule.category, rule.metric, healthData, rule.metricTarget);
      if (!extraction) {
        logger.debug('No metric extraction', { ruleId: rule.id, category: rule.category, metric: rule.metric });
        continue;
      }

      for (const { resourceId, value } of extraction.values) {
        // Check resource scope for container rules
        if (rule.category === 'container' && rule.resourceIds?.length > 0) {
          if (!rule.resourceIds.includes(resourceId)) continue;
        }

        const compositeResourceId =
          rule.category === 'container' || rule.metric === 'disk' || isPerDeviceNodeMetric(rule.metric)
            ? `${nodeId}:${resourceId}`
            : nodeId;

        if (Number.isNaN(value)) {
          logger.warn('Skipping NaN metric value', { ruleId: rule.id, metric: rule.metric, resourceId });
          continue;
        }

        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        logger.debug('Threshold check', {
          ruleId: rule.id,
          ruleName: rule.name,
          metric: rule.metric,
          value: Math.round(value * 100) / 100,
          threshold: rule.thresholdValue,
          operator: rule.operator,
          breached,
          resourceId: compositeResourceId,
        });

        await this.recordProbeOutcome(
          rule.id,
          compositeResourceId,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
        );

        if (breached) {
          await this.handleThresholdBreach(rule, compositeResourceId, value, nodeId, resourceId);
        } else {
          await this.handleThresholdClear(rule, compositeResourceId, value, nodeId, resourceId);
        }
      }
    }
  }

  async evaluateDatabaseSnapshot(snapshot: {
    databaseId: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    name: string;
    metrics: Record<string, number | null>;
  }): Promise<void> {
    const rules = await this.getThresholdRules();
    if (rules.length === 0) return;

    const category =
      snapshot.type === 'postgres'
        ? 'database_postgres'
        : snapshot.type === 'clickhouse'
          ? 'database_clickhouse'
          : 'database_redis';

    for (const rule of rules) {
      if (rule.category !== category) continue;
      if (rule.resourceIds?.length > 0 && !rule.resourceIds.includes(snapshot.databaseId)) continue;

      const extraction = extractMetricFromDatabaseSnapshot(rule.category, rule.metric, snapshot);
      if (!extraction) continue;

      for (const { resourceId, value } of extraction.values) {
        if (Number.isNaN(value)) continue;

        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        await this.recordProbeOutcome(
          rule.id,
          resourceId,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
        );
        if (breached) {
          await this.handleThresholdBreach(rule, resourceId, value, snapshot.databaseId, snapshot.name);
        } else {
          await this.handleThresholdClear(rule, resourceId, value, snapshot.databaseId, snapshot.name);
        }
      }
    }
  }
  async evaluateHostingAccount(snapshot: HostingAccountObservation): Promise<void> {
    if (snapshot.syncStatus !== 'success' || !snapshot.summary) return;
    for (const rule of await this.getThresholdRules()) {
      if (rule.category !== 'hosting_account' || !['balance', 'monthly_expenses'].includes(rule.metric)) continue;
      if (rule.resourceIds?.length && !rule.resourceIds.includes(snapshot.connectorId)) continue;
      const money = rule.metric === 'balance' ? snapshot.summary.balance : snapshot.summary.monthlyExpenses;
      if (!money || money.currency !== rule.metricTarget || !/^[-+]?\d+(?:\.\d+)?$/.test(money.amount)) continue;
      const value = Number(money.amount);
      if (!Number.isFinite(value)) continue;
      const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
      // Currency is part of the persistent alert key; an account currency change must not resolve a different currency's alert.
      const key = `${snapshot.connectorId}:${money.currency}`;
      await this.recordProbeOutcome(
        rule.id,
        key,
        breached,
        Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
      );
      if ((breached ? rule.durationSeconds : rule.resolveAfterSeconds) > 0 && !this.redis) continue;
      const details: TemplateDetails = {
        resourceId: snapshot.connectorId,
        details: { currency: money.currency, provider: snapshot.provider, estimated: money.estimated ?? false },
      };
      if (breached) await this.handleThresholdBreach(rule, key, value, snapshot.connectorId, snapshot.name, details);
      else await this.handleThresholdClear(rule, key, value, snapshot.connectorId, snapshot.name, details);
    }
  }

  /** Serialize rule edits between old observations and new ones, not through a cache-only race. */
  async updateHostingRule<T>(previous: any, update: () => Promise<T>): Promise<T> {
    const oldBarrier = this.hostingRuleBarrier;
    const pending = [...this.hostingEventChains.values()];
    let release!: () => void;
    this.hostingRuleBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await oldBarrier;
      await Promise.allSettled(pending);
      const next = await update();
      this.invalidateRuleCache();
      await this.reconcileHostingRuleUpdate(previous, next);
      return next;
    } finally {
      release();
    }
  }

  /** Editing the source of a rule must not leave its old currency/resource firing forever. */
  async reconcileHostingRuleUpdate(previous: any, next: any): Promise<void> {
    if (!['hosting_account', 'hosting_vm'].includes(previous.category)) return;
    const keys = [
      'enabled',
      'metric',
      'metricTarget',
      'operator',
      'thresholdValue',
      'eventPattern',
      'resourceIds',
      'durationSeconds',
      'resolveAfterSeconds',
      'fireThresholdPercent',
      'resolveThresholdPercent',
    ];
    if (!keys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))) return;
    this.invalidateRuleCache();
    const states = await this.db
      .select()
      .from(notificationAlertStates)
      .where(and(eq(notificationAlertStates.ruleId, previous.id), eq(notificationAlertStates.status, 'firing')));
    for (const state of states) {
      const resourceId = previous.category === 'hosting_account' ? state.resourceId.split(':')[0] : state.resourceId;
      await this.resolveAlert(state.id, previous, state.resourceType, state.resourceId, resourceId, {
        resourceId,
        details: { reason: 'rule_updated' },
      });
    }
  }

  /**
   * Resolve firing states a rule edit orphaned. A state that is never evaluated again (rule disabled,
   * different metric/event, resource dropped from scope) would otherwise stay firing forever and, through
   * the unique firing index, suppress every later incident for that resource.
   */
  async reconcileRuleUpdate(previous: any, next: any): Promise<void> {
    if (HOSTING_CATEGORIES.has(previous.category)) {
      await this.reconcileHostingRuleUpdate(previous, next);
      return;
    }
    const sourceChanged = RULE_SOURCE_KEYS.some(
      (key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null)
    );
    const scopeChanged = JSON.stringify(previous.resourceIds ?? []) !== JSON.stringify(next.resourceIds ?? []);
    if (next.enabled && !sourceChanged && !scopeChanged) return;
    this.invalidateRuleCache();

    const states = await this.db
      .select()
      .from(notificationAlertStates)
      .where(and(eq(notificationAlertStates.ruleId, previous.id), eq(notificationAlertStates.status, 'firing')));
    for (const state of states) {
      const reason = !next.enabled
        ? 'rule_disabled'
        : sourceChanged
          ? 'rule_updated'
          : !this.stateInRuleScope(next, state)
            ? 'out_of_scope'
            : null;
      if (reason) await this.resolveOrphanedState(state, next, reason);
    }
  }

  /**
   * Periodic and rule-change sweep over every firing state: resolves states whose rule is disabled,
   * whose resource left the rule scope, whose rule now watches a different metric/event, or whose
   * resource was deleted. Covers edits made outside the REST route (AI and MCP tools).
   */
  async reconcileStaleAlertStates(): Promise<number> {
    const rows = await this.db
      .select({ state: notificationAlertStates, rule: notificationAlertRules })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(eq(notificationAlertStates.status, 'firing'));
    if (rows.length === 0) return 0;

    const missing = await this.findStatesWithDeletedResources(rows);
    let resolved = 0;
    for (const { state, rule } of rows) {
      const reason = !rule.enabled
        ? 'rule_disabled'
        : !this.stateInRuleScope(rule, state)
          ? 'out_of_scope'
          : this.stateWatchesOtherSource(rule, state)
            ? 'rule_updated'
            : missing.has(state.id)
              ? 'resource_deleted'
              : null;
      if (!reason) continue;
      await this.resolveOrphanedState(state, rule, reason);
      resolved++;
    }
    return resolved;
  }

  /**
   * Resolved rows accumulate forever otherwise (every event alert inserts one). Keep them for 30 days,
   * or longer when an event rule's cooldown still reads its newest row.
   */
  async pruneResolvedAlertStates(): Promise<void> {
    const cutoff = new Date(Date.now() - RESOLVED_STATE_RETENTION_MS);
    await this.db
      .delete(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.status, 'resolved'),
          lt(notificationAlertStates.resolvedAt, cutoff),
          sql`${notificationAlertStates.resolvedAt} < now() - make_interval(secs => coalesce((select ${notificationAlertRules.cooldownSeconds} from ${notificationAlertRules} where ${notificationAlertRules.id} = ${notificationAlertStates.ruleId}), 0))`
        )
      );
  }

  private scheduleStateMaintenance(): void {
    if (this.maintenanceDebounce) return;
    this.maintenanceDebounce = setTimeout(() => {
      this.maintenanceDebounce = null;
      void this.runStateMaintenance();
    }, STATE_MAINTENANCE_DEBOUNCE_MS);
    this.maintenanceDebounce.unref?.();
  }

  private runStateMaintenance(): Promise<void> {
    if (this.maintenanceRun) return this.maintenanceRun;
    this.maintenanceRun = (async () => {
      try {
        const resolved = await this.reconcileStaleAlertStates();
        if (resolved > 0) logger.info('Resolved orphaned alert states', { count: resolved });
        if (Date.now() - this.lastResolvedStatePrune >= RESOLVED_STATE_PRUNE_INTERVAL_MS) {
          this.lastResolvedStatePrune = Date.now();
          await this.pruneResolvedAlertStates();
        }
      } catch (error) {
        logger.warn('Alert state maintenance failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.maintenanceRun = null;
      }
    })();
    return this.maintenanceRun;
  }

  /** Match a state key against the rule scope; keys may be composite (node:mount, node:container, account:currency). */
  private stateInRuleScope(rule: any, state: Pick<AlertStateRow, 'resourceId'>): boolean {
    const scope = (rule.resourceIds ?? []) as string[];
    if (scope.length === 0) return true;
    const key = state.resourceId;
    const separator = key.indexOf(':');
    const candidates = separator > 0 ? [key, key.slice(0, separator), key.slice(separator + 1)] : [key];
    return candidates.some((candidate) => scope.includes(candidate));
  }

  /** The state was raised for a metric/event the rule no longer watches. */
  private stateWatchesOtherSource(rule: any, state: Pick<AlertStateRow, 'context'>): boolean {
    const context = (state.context ?? {}) as { metric?: { name?: unknown }; event?: { name?: unknown } };
    if (rule.type === 'threshold') {
      const metric = context.metric?.name;
      return typeof metric === 'string' && !!rule.metric && metric !== rule.metric;
    }
    const eventName = context.event?.name;
    return typeof eventName === 'string' && !!rule.eventPattern && eventName !== rule.eventPattern;
  }

  /**
   * The table a firing state's resource lives in, only for sources whose key is known to be that
   * table's id. Anything else is left alone: a wrong "deleted" verdict would resolve and re-fire forever.
   */
  private resourceReference(rule: any, state: AlertStateRow): { kind: ResourceKind; id: string } | null {
    const nodeId = state.resourceId.split(':')[0] ?? state.resourceId;
    const eventPattern = String(rule.eventPattern ?? '');
    const threshold = rule.type === 'threshold';
    switch (rule.category) {
      case 'node':
        // Metric states are keyed node or node:device; lifecycle states come from the node registry.
        return threshold || eventPattern === 'offline' || eventPattern === 'online'
          ? { kind: 'node', id: nodeId }
          : null;
      case 'container':
        // Metric states are keyed node:container; lifecycle states only carry the container name.
        return threshold && state.resourceId.includes(':') ? { kind: 'node', id: nodeId } : null;
      case 'proxy':
        return state.resourceType === 'proxy' &&
          (eventPattern.startsWith('health.') || eventPattern === 'maintenance.active')
          ? { kind: 'proxy', id: state.resourceId }
          : null;
      case 'certificate':
        return threshold && state.resourceType === 'certificate' ? { kind: 'certificate', id: state.resourceId } : null;
      case 'database_postgres':
      case 'database_clickhouse':
      case 'database_redis':
        // Snapshot metrics and monitoring health are keyed by the database connection id.
        return (threshold && state.resourceType === rule.category) ||
          (state.resourceType === 'database' && eventPattern.startsWith('health.'))
          ? { kind: 'database', id: state.resourceId }
          : null;
      case 'logging':
        return threshold ? { kind: 'logging', id: state.resourceId } : null;
      default:
        return null;
    }
  }

  private async findStatesWithDeletedResources(rows: Array<{ state: AlertStateRow; rule: any }>): Promise<Set<string>> {
    const byKind = new Map<ResourceKind, Map<string, string[]>>();
    for (const { state, rule } of rows) {
      const ref = this.resourceReference(rule, state);
      if (!ref || !UUID_PATTERN.test(ref.id)) continue;
      const ids = byKind.get(ref.kind) ?? new Map<string, string[]>();
      ids.set(ref.id, [...(ids.get(ref.id) ?? []), state.id]);
      byKind.set(ref.kind, ids);
    }

    const missing = new Set<string>();
    for (const [kind, ids] of byKind) {
      const wanted = [...ids.keys()];
      const found = new Set((await this.findExistingResourceIds(kind, wanted)).map((row) => row.id));
      for (const id of wanted) {
        if (!found.has(id)) for (const stateId of ids.get(id) ?? []) missing.add(stateId);
      }
    }
    return missing;
  }

  private findExistingResourceIds(kind: ResourceKind, ids: string[]): Promise<Array<{ id: string }>> {
    switch (kind) {
      case 'node':
        return this.db.select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, ids));
      case 'proxy':
        return this.db.select({ id: proxyHosts.id }).from(proxyHosts).where(inArray(proxyHosts.id, ids));
      case 'certificate':
        return this.db.select({ id: sslCertificates.id }).from(sslCertificates).where(inArray(sslCertificates.id, ids));
      case 'database':
        return this.db
          .select({ id: databaseConnections.id })
          .from(databaseConnections)
          .where(inArray(databaseConnections.id, ids));
      case 'logging':
        return this.db
          .select({ id: loggingEnvironments.id })
          .from(loggingEnvironments)
          .where(inArray(loggingEnvironments.id, ids));
    }
  }

  private async resolveOrphanedState(state: AlertStateRow, rule: any, reason: string): Promise<void> {
    const context = (state.context ?? {}) as TemplateDetails & { metric?: Record<string, unknown> };
    const firedAt = state.firedAt;
    await this.resolveAlert(
      state.id,
      rule,
      state.resourceType,
      state.resourceId,
      state.resourceId,
      {
        ...context,
        ...(context.metric ? { metric: { ...context.metric, value: null } as TemplateDetails['metric'] } : {}),
        fired: {
          at: firedAt?.toISOString() ?? null,
          duration: firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0,
        },
        resolution: { reason },
      },
      // A rule the operator switched off must not keep talking to its webhooks.
      { notify: reason !== 'rule_disabled' }
    );
  }

  async evaluateLoggingRatios(now = new Date()): Promise<void> {
    if (!this.loggingEnvironmentService || !this.loggingClickHouseService) return;
    const rules = (await this.getThresholdRules()).filter(
      (rule) =>
        rule.category === 'logging' &&
        (rule.metric === 'error_fatal_ratio_percent' || rule.metric === 'fatal_ratio_percent')
    );
    if (rules.length === 0) return;

    const environments = (await this.loggingEnvironmentService.list()).filter((environment) => environment.enabled);
    const from = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    for (const environment of environments) {
      const matchingRules = rules.filter(
        (rule) => !rule.resourceIds?.length || rule.resourceIds.includes(environment.id)
      );
      if (matchingRules.length === 0) continue;
      try {
        const facets = await this.loggingClickHouseService.getFacets(environment.id, {
          from,
          to: now.toISOString(),
        });
        const counts = new Map(facets.severities.map((item) => [item.severity, item.count]));
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        if (total < 20) continue;
        const fatal = counts.get('fatal') ?? 0;
        const error = counts.get('error') ?? 0;
        for (const rule of matchingRules) {
          const value = ((rule.metric === 'fatal_ratio_percent' ? fatal : error + fatal) / total) * 100;
          const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
          await this.recordProbeOutcome(
            rule.id,
            environment.id,
            breached,
            Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
            LOGGING_RATIO_SAMPLING_MS
          );
          if (breached) {
            await this.handleThresholdBreach(rule, environment.id, value, environment.id, environment.name);
          } else {
            await this.handleThresholdClear(rule, environment.id, value, environment.id, environment.name);
          }
        }
      } catch (error) {
        logger.warn('Failed to evaluate logging ratios', {
          environmentId: environment.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async evaluateCertificateExpiry(now = new Date()): Promise<void> {
    const rules = (await this.getThresholdRules()).filter(
      (rule) => rule.category === 'certificate' && rule.metric === 'days_until_expiry'
    );
    if (rules.length === 0) return;

    const certs = await this.db
      .select({
        id: sslCertificates.id,
        name: sslCertificates.name,
        domainNames: sslCertificates.domainNames,
        notAfter: sslCertificates.notAfter,
      })
      .from(sslCertificates)
      .where(eq(sslCertificates.status, 'active'));

    const activeCerts = certs.filter((cert) => cert.notAfter);
    const activeCertIds = new Set(activeCerts.map((cert) => cert.id));

    for (const rule of rules) {
      const scopedIds = new Set((rule.resourceIds ?? []) as string[]);

      for (const cert of activeCerts) {
        if (scopedIds.size > 0 && !scopedIds.has(cert.id)) continue;

        const notAfter = cert.notAfter!;
        const daysUntilExpiry = Math.ceil((notAfter.getTime() - now.getTime()) / DAY_MS);
        const breached = evaluateThreshold(daysUntilExpiry, rule.operator, rule.thresholdValue);

        if (breached) {
          await this.handleCertificateThresholdBreach(rule, cert, daysUntilExpiry);
        } else {
          await this.handleCertificateThresholdClear(rule, cert, daysUntilExpiry);
        }
      }

      await this.resolveStaleCertificateStates(rule, activeCertIds);
    }
  }

  private async handleCertificateThresholdBreach(
    rule: any,
    cert: {
      id: string;
      name: string;
      domainNames: string[];
      notAfter: Date | null;
    },
    daysUntilExpiry: number
  ): Promise<void> {
    // Expiry is evaluated once a day (and on certificate changes). Fire/resolve windows shorter than a
    // day can never be covered by samples, so stored windows are ignored and the rule acts on each check.
    const existingState = await this.getActiveAlertState(rule.id, 'certificate', cert.id);
    if (existingState) return;

    await this.fireAlert(rule, 'certificate', cert.id, cert.name || cert.domainNames.join(', ') || cert.id, {
      resourceId: cert.id,
      metric: {
        name: rule.metric,
        value: daysUntilExpiry,
        threshold: rule.thresholdValue,
        operator: rule.operator,
        duration: rule.durationSeconds ?? 0,
      },
      certificate: {
        days_until_expiry: daysUntilExpiry,
        expiry_date: cert.notAfter?.toISOString() ?? null,
      },
    });
  }

  private async handleCertificateThresholdClear(
    rule: any,
    cert: {
      id: string;
      name: string;
      domainNames: string[];
      notAfter: Date | null;
    },
    daysUntilExpiry: number
  ): Promise<void> {
    const existingState = await this.getActiveAlertState(rule.id, 'certificate', cert.id);
    if (!existingState) return;

    const firedAt = existingState.firedAt;
    const firedDurationSec = firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0;

    await this.resolveAlert(
      existingState.id,
      rule,
      'certificate',
      cert.id,
      cert.name || cert.domainNames.join(', ') || cert.id,
      {
        resourceId: cert.id,
        metric: {
          name: rule.metric,
          value: daysUntilExpiry,
          threshold: rule.thresholdValue,
          operator: rule.operator,
          duration: rule.durationSeconds ?? 0,
        },
        certificate: {
          days_until_expiry: daysUntilExpiry,
          expiry_date: cert.notAfter?.toISOString() ?? null,
        },
        fired: {
          at: firedAt?.toISOString() ?? null,
          duration: firedDurationSec,
        },
      }
    );
  }

  private async resolveStaleCertificateStates(rule: any, activeCertIds: Set<string>): Promise<void> {
    const states = await this.db
      .select()
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.ruleId, rule.id),
          eq(notificationAlertStates.resourceType, 'certificate'),
          eq(notificationAlertStates.status, 'firing')
        )
      );
    const scopedIds = new Set((rule.resourceIds ?? []) as string[]);

    for (const state of states) {
      const stillActive = activeCertIds.has(state.resourceId);
      const stillInScope = scopedIds.size === 0 || scopedIds.has(state.resourceId);
      if (stillActive && stillInScope) continue;

      const firedAt = state.firedAt;
      const firedDurationSec = firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0;

      await this.resolveAlert(state.id, rule, 'certificate', state.resourceId, state.resourceId, {
        resourceId: state.resourceId,
        metric: {
          name: rule.metric,
          value: null,
          threshold: rule.thresholdValue,
          operator: rule.operator,
          duration: rule.durationSeconds ?? 0,
        },
        certificate: {
          days_until_expiry: null,
          expiry_date: null,
        },
        fired: {
          at: firedAt?.toISOString() ?? null,
          duration: firedDurationSec,
        },
        resolution: {
          reason: stillActive ? 'out_of_scope' : 'certificate_inactive_or_deleted',
        },
      });
    }
  }

  private async handleThresholdBreach(
    rule: any,
    compositeResourceId: string,
    currentValue: number,
    nodeId: string,
    rawResourceId: string,
    extraDetails: TemplateDetails = {}
  ): Promise<void> {
    const durationMs = (rule.durationSeconds ?? 0) * 1000;

    if (durationMs > 0 && this.redis) {
      const evaluation = await this.evaluateRatioWindow(
        rule.id,
        compositeResourceId,
        durationMs,
        rule.fireThresholdPercent ?? 100,
        'breach'
      );

      if (!evaluation?.hasCoverage) {
        logger.debug('Fire ratio window has insufficient coverage', { ruleId: rule.id, durationMs });
        return;
      }

      if (!evaluation.thresholdMet) {
        logger.debug('Fire ratio threshold not met', {
          ruleId: rule.id,
          sampleCount: evaluation.sampleCount,
          matchingSamples: evaluation.matchingSamples,
          ratioPercent: Math.round(evaluation.ratioPercent * 100) / 100,
          thresholdPercent: rule.fireThresholdPercent ?? 100,
        });
        return;
      }
    } else if (durationMs > 0 && !this.redis) {
      logger.debug('Fire ratio window skipped: no Redis', { ruleId: rule.id });
    }

    const existingState = await this.getActiveAlertState(rule.id, rule.category, compositeResourceId);
    if (existingState) {
      logger.debug('Alert already firing', { ruleId: rule.id, stateId: existingState.id });
      return;
    }

    const nodeName = rule.category === 'node' || rule.category === 'container' ? this.getNodeName(nodeId) : undefined;
    const resourceName = this.getThresholdResourceName(rule, nodeId, rawResourceId);

    await this.fireAlert(rule, rule.category, compositeResourceId, resourceName, {
      ...extraDetails,
      resourceId: this.getThresholdResourceId(rule, nodeId),
      metric: {
        name: rule.metric,
        value: currentValue,
        threshold: rule.thresholdValue,
        operator: rule.operator,
        duration: rule.durationSeconds ?? 0,
      },
      node: {
        id: rule.category === 'node' || rule.category === 'container' ? nodeId : null,
        name: nodeName ?? null,
      },
    });
  }

  private async handleThresholdClear(
    rule: any,
    compositeResourceId: string,
    currentValue: number,
    sourceId?: string,
    rawResourceId?: string,
    extraDetails: TemplateDetails = {}
  ): Promise<void> {
    const existingState = await this.getActiveAlertState(rule.id, rule.category, compositeResourceId);
    if (!existingState) return;

    const resolveMs = (rule.resolveAfterSeconds ?? 60) * 1000;

    if (resolveMs > 0 && this.redis) {
      const evaluation = await this.evaluateRatioWindow(
        rule.id,
        compositeResourceId,
        resolveMs,
        rule.resolveThresholdPercent ?? 100,
        'clear'
      );

      if (!evaluation?.hasCoverage) {
        logger.debug('Resolve ratio window has insufficient coverage', { ruleId: rule.id, resolveMs });
        return;
      }

      if (!evaluation.thresholdMet) {
        logger.debug('Resolve ratio threshold not met', {
          ruleId: rule.id,
          sampleCount: evaluation.sampleCount,
          matchingSamples: evaluation.matchingSamples,
          ratioPercent: Math.round(evaluation.ratioPercent * 100) / 100,
          thresholdPercent: rule.resolveThresholdPercent ?? 100,
        });
        return;
      }
    } else if (resolveMs > 0 && !this.redis) {
      logger.debug('Resolve ratio window skipped: no Redis', { ruleId: rule.id });
    }

    const firedAt = existingState.firedAt;
    const firedDurationSec = firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0;

    const nodeName =
      rule.category === 'node' || rule.category === 'container'
        ? this.getNodeName(compositeResourceId.split(':')[0] || compositeResourceId)
        : undefined;
    const resourceName = this.getThresholdResourceName(rule, sourceId ?? compositeResourceId, rawResourceId);

    await this.resolveAlert(existingState.id, rule, rule.category, compositeResourceId, resourceName, {
      ...extraDetails,
      resourceId: this.getThresholdResourceId(rule, sourceId),
      metric: {
        name: rule.metric,
        value: currentValue,
        threshold: rule.thresholdValue,
        operator: rule.operator,
        duration: rule.durationSeconds ?? 0,
      },
      node: {
        id:
          rule.category === 'node' || rule.category === 'container' ? compositeResourceId.split(':')[0] || null : null,
        name: nodeName ?? null,
      },
      fired: {
        at: firedAt?.toISOString() ?? null,
        duration: firedDurationSec,
      },
    });
  }

  private getProbeOutcomeKey(ruleId: string, compositeResourceId: string): string {
    return `notif:threshold:outcomes:${ruleId}:${compositeResourceId}`;
  }

  /**
   * Record one sample for a rule/resource. The zset is trimmed to the evaluation window but always
   * keeps the newest sample taken before it: that sample is the state at the start of the window.
   * Without it, any source sampled less often than the window (logging ratios every 5 minutes,
   * uptime checks every 2+ minutes) can never cover the window, so the rule never fires or resolves.
   */
  private async recordProbeOutcome(
    ruleId: string,
    compositeResourceId: string,
    breached: boolean,
    windowMs: number,
    samplingPeriodMs = 0
  ): Promise<void> {
    if (!this.redis) return;

    const now = Date.now();
    const redisKey = this.getProbeOutcomeKey(ruleId, compositeResourceId);
    await this.redis.zadd(redisKey, now, `${now}:${breached ? 1 : 0}`);

    const windowStart = now - Math.max(windowMs, 0);
    const anchor = this.parseProbeOutcomeSamples(
      await this.redis.zrevrangebyscore(redisKey, `(${windowStart}`, '-inf', 'LIMIT', 0, 1)
    )[0];
    if (anchor) await this.redis.zremrangebyscore(redisKey, '-inf', `(${anchor.timestamp}`);

    // The anchor must survive until the next sample arrives.
    const ttlSeconds = Math.max(
      METRIC_BUFFER_TTL,
      Math.ceil((Math.max(windowMs, 0) + 2 * Math.max(samplingPeriodMs, 0)) / 1000)
    );
    await this.redis.expire(redisKey, ttlSeconds);
  }

  private parseProbeOutcomeSamples(samples: string[]): WindowProbeSample[] {
    return samples.flatMap((sample) => {
      const [timestampRaw, breachedRaw] = sample.split(':');
      const timestamp = Number.parseInt(timestampRaw ?? '', 10);
      if (!Number.isFinite(timestamp)) return [];
      return [{ timestamp, breached: breachedRaw === '1' }];
    });
  }

  private async evaluateRatioWindow(
    ruleId: string,
    compositeResourceId: string,
    windowMs: number,
    thresholdPercent: number,
    targetState: 'breach' | 'clear'
  ) {
    if (!this.redis) return null;

    const now = Date.now();
    const redisKey = this.getProbeOutcomeKey(ruleId, compositeResourceId);
    const windowStart = now - windowMs;
    const [inWindow, beforeWindow] = await Promise.all([
      this.redis.zrangebyscore(redisKey, windowStart, '+inf'),
      this.redis.zrevrangebyscore(redisKey, `(${windowStart}`, '-inf', 'LIMIT', 0, 1),
    ]);
    const windowSamples = this.parseProbeOutcomeSamples(inWindow).sort((a, b) => a.timestamp - b.timestamp);
    const preWindowAnchor = this.parseProbeOutcomeSamples(beforeWindow)[0];

    return evaluateWindowRatio(
      preWindowAnchor ? [preWindowAnchor, ...windowSamples] : windowSamples,
      targetState,
      thresholdPercent,
      windowMs,
      now
    );
  }

  // ── EventBus Event Handling ─────────────────────────────────────────

  private async handleBusEvent(channel: string, payload: any): Promise<void> {
    if (channel === 'hosting.account.observed') await this.evaluateHostingAccount(payload);
    const mappings = EVENT_BUS_MAPPINGS[channel];
    if (!mappings) return;

    for (const mapping of mappings) {
      if (!mapping.match(payload)) continue;

      const resource = mapping.extractResource(payload);
      const extraData = mapping.extractData?.(payload) ?? {};

      if (mapping.stateful) {
        await this.observeStatefulEvent(
          mapping.category,
          mapping.stateful.currentState(payload),
          resource,
          extraData,
          mapping.stateful.observedPatterns
        );
        continue;
      }

      // Find event-type alert rules matching this category + event
      const eventRules = await this.getEventRules();

      for (const rule of eventRules) {
        if (rule.category !== mapping.category) continue;
        if (rule.eventPattern !== mapping.eventId) continue;

        // Check resource scope
        if (rule.resourceIds?.length > 0) {
          if (!rule.resourceIds.includes(resource.id)) continue;
        }

        if (eventSupportsThreshold(rule.category, rule.eventPattern)) {
          continue;
        }

        // For events, check cooldown based on last notification time (not persistent firing state)
        if (await this.isEventInCooldown(rule.id, resource.type, resource.id, rule.cooldownSeconds)) continue;

        await this.fireEventAlert(
          rule,
          resource.type,
          resource.id,
          resource.name ?? resource.id,
          this.getEventTemplateDetails(extraData, mapping.eventId, undefined, resource.id)
        );
      }
    }

    if (channel === 'ssl.cert.changed') {
      await this.evaluateCertificateExpiry();
    }
  }

  async observeStatefulEvent(
    category: string,
    currentState: string,
    resource: { type: string; id: string; name?: string },
    context: Record<string, unknown> = {},
    observedPatterns?: string[],
    /** How often this source is observed, when periodic; keeps the window anchor alive between samples. */
    samplingPeriodMs?: number
  ): Promise<void> {
    const eventRules = await this.getEventRules();
    const observedPatternSet = observedPatterns ? new Set(observedPatterns) : null;

    for (const rule of eventRules) {
      if (rule.category !== category) continue;
      if (!eventSupportsThreshold(rule.category, rule.eventPattern)) continue;
      if (observedPatternSet && !observedPatternSet.has(rule.eventPattern)) continue;
      if (rule.resourceIds?.length > 0 && !rule.resourceIds.includes(resource.id)) continue;

      const active = rule.eventPattern === currentState;
      await this.recordProbeOutcome(
        rule.id,
        resource.id,
        active,
        Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
        samplingPeriodMs
      );

      const existingState = await this.getActiveAlertState(rule.id, resource.type, resource.id);

      if (active) {
        const durationMs = (rule.durationSeconds ?? 0) * 1000;
        if (durationMs > 0 && this.redis) {
          const evaluation = await this.evaluateRatioWindow(
            rule.id,
            resource.id,
            durationMs,
            rule.fireThresholdPercent ?? 100,
            'breach'
          );
          if (!evaluation?.hasCoverage || !evaluation.thresholdMet) continue;
        } else if (durationMs > 0 && !this.redis) {
          continue;
        }

        if (existingState) continue;

        await this.fireAlert(
          rule,
          resource.type,
          resource.id,
          resource.name ?? resource.id,
          this.getEventTemplateDetails(context, rule.eventPattern, currentState, resource.id)
        );
        continue;
      }

      if (!existingState) continue;

      const resolveMs = (rule.resolveAfterSeconds ?? 60) * 1000;
      if (resolveMs > 0 && this.redis) {
        const evaluation = await this.evaluateRatioWindow(
          rule.id,
          resource.id,
          resolveMs,
          rule.resolveThresholdPercent ?? 100,
          'clear'
        );
        if (!evaluation?.hasCoverage || !evaluation.thresholdMet) continue;
      } else if (resolveMs > 0 && !this.redis) {
        continue;
      }

      await this.resolveAlert(
        existingState.id,
        rule,
        resource.type,
        resource.id,
        resource.name,
        this.getEventTemplateDetails(context, rule.eventPattern, currentState, resource.id)
      );
    }
  }

  async reconcileProxyMaintenance(resourceId?: string): Promise<void> {
    const eventRules = (await this.getEventRules()).filter(
      (rule) => rule.category === 'proxy' && rule.eventPattern === 'maintenance.active'
    );
    const hosts = await this.db.query.proxyHosts.findMany({
      where: resourceId
        ? and(eq(proxyHosts.id, resourceId), eq(proxyHosts.isSystem, false))
        : eq(proxyHosts.isSystem, false),
    });

    for (const host of hosts) {
      const active = host.enabled && host.maintenanceEnabled;
      await this.observeStatefulEvent(
        'proxy',
        active ? 'maintenance.active' : 'maintenance.inactive',
        { type: 'proxy', id: host.id, name: host.domainNames?.[0] ?? host.id },
        { maintenance_active: active },
        ['maintenance.active']
      );
    }

    const conditions = [
      eq(notificationAlertStates.status, 'firing'),
      eq(notificationAlertStates.resourceType, 'proxy'),
      eq(notificationAlertRules.category, 'proxy'),
    ];
    if (resourceId) conditions.push(eq(notificationAlertStates.resourceId, resourceId));
    const firingStates = await this.db
      .select({ state: notificationAlertStates, rule: notificationAlertRules })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(and(...conditions));

    const hostsById = new Map(hosts.map((host) => [host.id, host]));
    const enabledRuleIds = new Set(eventRules.map((rule) => rule.id));
    for (const { state, rule } of firingStates) {
      const stateEventName = (state.context as { event?: { name?: string } } | null)?.event?.name;
      if (stateEventName !== 'maintenance.active' && rule.eventPattern !== 'maintenance.active') continue;
      const host = hostsById.get(state.resourceId);
      const scopedIds = (rule.resourceIds ?? []) as string[];
      const stale =
        !enabledRuleIds.has(rule.id) || !host || (scopedIds.length > 0 && !scopedIds.includes(state.resourceId));
      if (!stale) continue;

      await this.resolveAlert(state.id, rule, 'proxy', state.resourceId, host?.domainNames?.[0] ?? state.resourceId, {
        resourceId: state.resourceId,
        state: { current: host?.maintenanceEnabled ? 'maintenance.active' : 'maintenance.inactive' },
        event: { name: 'maintenance.active' },
        resolution: { reason: 'resource_inactive_deleted_or_out_of_scope' },
      });
    }
  }

  // ── Alert State Management ──────────────────────────────────────────

  /**
   * Transactional outbox: the alert state change and its webhook deliveries commit together, so a
   * restart or a failed send after commit leaves queued deliveries for the retry job instead of a
   * silently lost notification. Returns false when the state change did not apply (lost a race).
   */
  private async commitWithDeliveries(
    rule: any,
    event: NotificationEvent | null,
    applyStateChange: (tx: DrizzleTransaction) => Promise<boolean>
  ): Promise<boolean> {
    const webhookIds = (rule.webhookIds ?? []) as string[];
    const webhooks =
      event && webhookIds.length > 0
        ? (await this.webhookService.getRawByIds(webhookIds)).filter((webhook) => webhook.enabled)
        : [];
    let deliveryIds: string[] = [];
    const applied = await this.db.transaction(async (tx) => {
      if (!(await applyStateChange(tx))) return false;
      if (event && webhooks.length > 0) deliveryIds = await this.dispatcherService.enqueue(tx, webhooks, event);
      return true;
    });
    if (applied && deliveryIds.length > 0) this.sendQueuedDeliveries(rule.id, deliveryIds);
    return applied;
  }

  private sendQueuedDeliveries(ruleId: string, deliveryIds: string[]): void {
    const work: Promise<void> = this.dispatcherService
      .deliverQueued(deliveryIds)
      .catch((err) => {
        logger.warn('Immediate alert delivery failed; the retry job will send it', {
          ruleId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => this.activeDeliveries.delete(work));
    this.activeDeliveries.add(work);
  }

  private async fireAlert(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): Promise<void> {
    // Render the alert's message template
    const now = new Date().toISOString();
    const resource = this.buildTemplateResource(resourceType, resourceKey, resourceName, details.resourceId);
    const messageContext = this.buildAlertTemplateContext(rule, 'alert.fired', 'firing', resource, now, {
      ...details,
      fired: { ...details.fired, at: details.fired?.at ?? now },
    });
    const message = rule.messageTemplate
      ? renderTemplate(rule.messageTemplate, messageContext)
      : `${rule.name}: ${resourceName}`;
    const eventContext = {
      ...messageContext,
      notification: { ...messageContext.notification, message },
    };

    // Build notification event
    const event: NotificationEvent = {
      type: 'alert.fired',
      title: rule.name,
      message,
      severity: rule.severity as Severity,
      resource,
      context: eventContext,
      timestamp: now,
    };

    const fired = await this.commitWithDeliveries(rule, event, async (tx) => {
      // The partial unique index on firing states makes a concurrent duplicate a no-op.
      const inserted = await tx
        .insert(notificationAlertStates)
        .values({
          ruleId: rule.id,
          resourceType,
          resourceId: resourceKey,
          status: 'firing',
          severity: rule.severity,
          context: details,
        })
        .onConflictDoNothing()
        .returning({ id: notificationAlertStates.id });
      return inserted.length > 0;
    });
    if (!fired) return; // already firing

    this.eventBus?.publish('alert.fired', {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      resourceType,
      resourceId: resourceKey,
    });

    logger.info('Alert fired', { ruleId: rule.id, ruleName: rule.name, resourceType, resourceId: resourceKey });
  }

  private async resolveAlert(
    stateId: string,
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string | undefined,
    details: TemplateDetails,
    options: { notify?: boolean } = {}
  ): Promise<void> {
    const now = new Date().toISOString();
    const resolvedResource = this.buildTemplateResource(
      resourceType,
      resourceKey,
      resourceName ?? resourceKey,
      details.resourceId
    );

    // Render resolve message if template exists
    const resolveContext = this.buildAlertTemplateContext(
      rule,
      'alert.resolved',
      'resolved',
      resolvedResource,
      now,
      details
    );
    const resolveMessage = rule.messageTemplate
      ? renderTemplate(rule.messageTemplate, resolveContext)
      : `${rule.name} has been resolved.`;
    const eventContext = {
      ...resolveContext,
      notification: { ...resolveContext.notification, message: resolveMessage },
    };

    const event: NotificationEvent = {
      type: 'alert.resolved',
      title: `Resolved: ${rule.name}`,
      message: resolveMessage,
      severity: 'info',
      resource: resolvedResource,
      context: eventContext,
      timestamp: now,
    };

    // Health reports and sweeps race on the same state: only the caller that flips it notifies.
    const resolved = await this.commitWithDeliveries(rule, options.notify === false ? null : event, async (tx) => {
      const rows = await tx
        .update(notificationAlertStates)
        .set({ status: 'resolved', resolvedAt: new Date() })
        .where(and(eq(notificationAlertStates.id, stateId), eq(notificationAlertStates.status, 'firing')))
        .returning({ id: notificationAlertStates.id });
      return rows.length > 0;
    });
    if (!resolved) return;

    this.eventBus?.publish('alert.resolved', {
      ruleId: rule.id,
      ruleName: rule.name,
      resourceType,
      resourceId: resourceKey,
    });

    logger.info('Alert resolved', { ruleId: rule.id, ruleName: rule.name, resourceType, resourceId: resourceKey });
  }

  /** Fire an event-type alert — no persistent state, just cooldown tracking */
  private async fireEventAlert(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): Promise<void> {
    // Dedup guard: use Redis SET NX to prevent concurrent duplicate dispatches
    if (this.redis) {
      const lockKey = `notif:event:lock:${rule.id}:${resourceType}:${resourceKey}`;
      const acquired = await this.redis.set(lockKey, '1', 'EX', 10, 'NX');
      if (!acquired) return; // another handler is already processing this event
    }

    const now = new Date().toISOString();
    const resource = this.buildTemplateResource(
      resourceType,
      resourceKey,
      resourceName,
      details.resourceId ?? resourceKey
    );
    const messageContext = this.buildAlertTemplateContext(rule, 'alert.fired', 'firing', resource, now, details);
    const message = rule.messageTemplate
      ? renderTemplate(rule.messageTemplate, messageContext)
      : `${rule.name}: ${resourceName}`;
    const eventContext = {
      ...messageContext,
      notification: { ...messageContext.notification, message },
    };

    const event: NotificationEvent = {
      type: 'alert.fired',
      title: rule.name,
      message,
      severity: rule.severity as Severity,
      resource,
      context: eventContext,
      timestamp: now,
    };

    // Record notification time for cooldown, in the same transaction as its deliveries.
    await this.commitWithDeliveries(rule, event, async (tx) => {
      await tx.insert(notificationAlertStates).values({
        ruleId: rule.id,
        resourceType,
        resourceId: resourceKey,
        status: 'resolved',
        severity: rule.severity,
        context: details,
        resolvedAt: new Date(),
      });
      return true;
    });

    this.eventBus?.publish('alert.fired', {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      resourceType,
      resourceId: resourceKey,
    });

    logger.info('Event alert fired', { ruleId: rule.id, ruleName: rule.name, resourceType, resourceId: resourceKey });
  }

  /** Check if an event-type alert is still in cooldown */
  private async isEventInCooldown(
    ruleId: string,
    resourceType: string,
    resourceId: string,
    cooldownSeconds: number
  ): Promise<boolean> {
    const [latest] = await this.db
      .select({ resolvedAt: notificationAlertStates.resolvedAt })
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.ruleId, ruleId),
          eq(notificationAlertStates.resourceType, resourceType),
          eq(notificationAlertStates.resourceId, resourceId)
        )
      )
      .orderBy(desc(notificationAlertStates.resolvedAt))
      .limit(1);

    if (!latest?.resolvedAt) return false;
    const elapsed = Date.now() - latest.resolvedAt.getTime();
    return elapsed < cooldownSeconds * 1000;
  }

  private async getActiveAlertState(ruleId: string, resourceType: string, resourceId: string) {
    const [state] = await this.db
      .select()
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.ruleId, ruleId),
          eq(notificationAlertStates.resourceType, resourceType),
          eq(notificationAlertStates.resourceId, resourceId),
          eq(notificationAlertStates.status, 'firing')
        )
      )
      .limit(1);
    return state ?? null;
  }

  // ── Rule Cache ──────────────────────────────────────────────────────

  private async refreshRuleCache() {
    if (Date.now() - this.lastRuleCacheRefresh > this.RULE_CACHE_TTL) {
      // Set timestamp before awaits to prevent thundering herd
      this.lastRuleCacheRefresh = Date.now();
      const [threshold, event] = await Promise.all([
        this.ruleService.getEnabledThresholdRules(),
        this.ruleService.getEnabledEventRules(),
      ]);
      this.thresholdRulesCache = threshold;
      this.eventRulesCache = event;
    }
  }

  private async getThresholdRules() {
    await this.refreshRuleCache();
    return this.thresholdRulesCache;
  }

  private async getEventRules() {
    await this.refreshRuleCache();
    return this.eventRulesCache;
  }

  invalidateRuleCache(): void {
    this.lastRuleCacheRefresh = 0;
  }

  private buildTemplateResource(
    type: string,
    key: string,
    name: string,
    id: string | null | undefined
  ): NotificationTemplateResource {
    return { type, id: id ?? null, key, name };
  }

  private buildAlertTemplateContext(
    rule: any,
    notificationType: 'alert.fired' | 'alert.resolved',
    status: 'firing' | 'resolved',
    resource: NotificationTemplateResource,
    timestamp: string,
    details: TemplateDetails
  ) {
    const { resourceId: _resourceId, ...templateDetails } = details;
    const severity = status === 'resolved' ? ('info' as Severity) : (rule.severity as Severity);
    return buildNotificationTemplateContext({
      ...templateDetails,
      notification: {
        type: notificationType,
        title: status === 'resolved' ? `Resolved: ${rule.name}` : rule.name,
        message: '',
        timestamp,
      },
      alert: {
        id: rule.id,
        name: rule.name,
        status,
        severity,
      },
      resource,
    });
  }

  private getEventTemplateDetails(
    context: Record<string, unknown>,
    eventName: string,
    currentState?: string,
    fallbackResourceId?: string
  ): TemplateDetails {
    const nodeId = typeof context.nodeId === 'string' ? context.nodeId : null;
    const explicitNodeName =
      typeof context.node_name === 'string'
        ? context.node_name
        : typeof context.hostname === 'string'
          ? context.hostname
          : null;
    const nodeName = explicitNodeName ?? (nodeId ? this.getNodeName(nodeId) : null);
    const healthStatus =
      typeof context.health_status === 'string'
        ? context.health_status
        : typeof context.healthStatus === 'string'
          ? context.healthStatus
          : null;
    const resourceId =
      typeof context.containerId === 'string'
        ? context.containerId
        : typeof fallbackResourceId === 'string'
          ? fallbackResourceId
          : null;
    const scalarDetails = Object.fromEntries(
      Object.entries(context).filter(
        ([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)
      )
    ) as Record<string, string | number | boolean | null>;

    return {
      resourceId,
      node: {
        id: nodeId,
        name: nodeName,
      },
      health: {
        status: healthStatus,
      },
      event: {
        name: eventName,
      },
      operation: {
        kind: typeof context.operation_kind === 'string' ? context.operation_kind : null,
        phase: typeof context.operation_phase === 'string' ? context.operation_phase : null,
        trigger: typeof context.operation_trigger === 'string' ? context.operation_trigger : null,
      },
      failure: {
        code: typeof context.failure_code === 'string' ? context.failure_code : null,
      },
      details: scalarDetails,
      state: {
        current: currentState ?? null,
      },
    };
  }

  private getNodeName(nodeId: string): string {
    const node = this.nodeRegistry.getNode(nodeId);
    return node?.hostname ?? nodeId;
  }

  private getThresholdResourceName(rule: any, sourceId: string, rawResourceId?: string): string {
    const nodeName = rule.category === 'node' || rule.category === 'container' ? this.getNodeName(sourceId) : undefined;
    if (rule.category === 'node' && isPerDeviceNodeMetric(rule.metric) && rawResourceId) {
      return `${nodeName || sourceId} · ${rawResourceId}`;
    }
    if (rule.category === 'node') return nodeName || sourceId;
    if (rawResourceId && rawResourceId !== 'system') return rawResourceId;
    return nodeName || rawResourceId || sourceId;
  }

  private getThresholdResourceId(rule: any, sourceId?: string): string | null {
    if (!sourceId) return null;
    if (
      rule.category === 'node' ||
      rule.category === 'database_postgres' ||
      rule.category === 'database_clickhouse' ||
      rule.category === 'database_redis' ||
      rule.category === 'logging' ||
      rule.category === 'hosting_account'
    ) {
      return sourceId;
    }
    return null;
  }
}
