import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationAlertRules, notificationAlertStates, proxyHosts, sslCertificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
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
const WINDOW_TRIM_PADDING_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type TemplateDetails = Partial<
  Pick<
    NotificationTemplateContextInput,
    'metric' | 'node' | 'health' | 'certificate' | 'state' | 'event' | 'fired' | 'resolution'
  >
> & { resourceId?: string | null };

export class NotificationEvaluatorService {
  private eventBus?: EventBusService;
  private redis: RedisClient | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly activeHandlers = new Set<Promise<void>>();

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

  start(): void {
    if (!this.eventBus) {
      logger.warn('EventBus not set, evaluator will not process events');
      return;
    }

    for (const channel of Object.keys(EVENT_BUS_MAPPINGS)) {
      const unsub = this.eventBus.subscribe(channel, (payload: unknown) => {
        const active = this.handleBusEvent(channel, payload)
          .catch((err) => {
            logger.error('Error handling event', { channel, error: err instanceof Error ? err.message : String(err) });
          })
          .finally(() => this.activeHandlers.delete(active));
        this.activeHandlers.add(active);
      });
      this.unsubscribers.push(unsub);
    }

    logger.info('Notification evaluator started', { channels: Object.keys(EVENT_BUS_MAPPINGS).length });
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    await Promise.allSettled([...this.activeHandlers]);
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

        await this.recordProbeOutcome(
          rule.id,
          cert.id,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
        );

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
    const durationMs = (rule.durationSeconds ?? 0) * 1000;

    if (durationMs > 0 && this.redis) {
      const evaluation = await this.evaluateRatioWindow(
        rule.id,
        cert.id,
        durationMs,
        rule.fireThresholdPercent ?? 100,
        'breach'
      );
      if (!evaluation?.hasCoverage || !evaluation.thresholdMet) return;
    } else if (durationMs > 0 && !this.redis) {
      logger.debug('Certificate expiry fire window skipped: no Redis', { ruleId: rule.id });
      return;
    }

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

    const resolveMs = (rule.resolveAfterSeconds ?? 60) * 1000;

    if (resolveMs > 0 && this.redis) {
      const evaluation = await this.evaluateRatioWindow(
        rule.id,
        cert.id,
        resolveMs,
        rule.resolveThresholdPercent ?? 100,
        'clear'
      );
      if (!evaluation?.hasCoverage || !evaluation.thresholdMet) return;
    } else if (resolveMs > 0 && !this.redis) {
      logger.debug('Certificate expiry resolve window skipped: no Redis', { ruleId: rule.id });
      return;
    }

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
    rawResourceId: string
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
    rawResourceId?: string
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

  private async recordProbeOutcome(
    ruleId: string,
    compositeResourceId: string,
    breached: boolean,
    windowMs: number
  ): Promise<void> {
    if (!this.redis) return;

    const now = Date.now();
    const redisKey = this.getProbeOutcomeKey(ruleId, compositeResourceId);
    await this.redis.zadd(redisKey, now, `${now}:${breached ? 1 : 0}`);
    await this.redis.expire(redisKey, METRIC_BUFFER_TTL);

    const trimWindowMs = Math.max(windowMs, 0);
    const cutoff = now - trimWindowMs - WINDOW_TRIM_PADDING_MS;
    await this.redis.zremrangebyscore(redisKey, '-inf', cutoff);
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
    const samples = await this.redis.zrangebyscore(redisKey, windowStart - WINDOW_TRIM_PADDING_MS, '+inf');
    const parsedSamples = this.parseProbeOutcomeSamples(samples).sort((a, b) => a.timestamp - b.timestamp);
    const preWindowAnchor = parsedSamples.filter((sample) => sample.timestamp < windowStart).at(-1);
    const windowSamples = parsedSamples.filter((sample) => sample.timestamp >= windowStart);

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
    const mappings = EVENT_BUS_MAPPINGS[channel];
    if (!mappings) return;

    for (const mapping of mappings) {
      if (!mapping.match(payload)) continue;

      const resource = mapping.extractResource(payload);
      const extraData = mapping.extractData?.(payload) ?? {};

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
          this.getEventTemplateDetails(extraData, mapping.eventId)
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
    observedPatterns?: string[]
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
        Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
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

  private async fireAlert(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): Promise<void> {
    try {
      await this.db.insert(notificationAlertStates).values({
        ruleId: rule.id,
        resourceType,
        resourceId: resourceKey,
        status: 'firing',
        severity: rule.severity,
        context: details,
      });
    } catch (err: any) {
      if (err.code === '23505') return; // already firing
      throw err;
    }

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

    // Dispatch to the alert's attached webhooks
    const webhookIds = (rule.webhookIds ?? []) as string[];
    if (webhookIds.length > 0) {
      const webhooks = await this.webhookService.getRawByIds(webhookIds);
      for (const webhook of webhooks) {
        if (!webhook.enabled) continue;
        this.dispatcherService.dispatch(webhook, event).catch((err) => {
          logger.error('Alert dispatch failed', { webhookId: webhook.id, ruleId: rule.id, error: err.message });
        });
      }
    }

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
    details: TemplateDetails
  ): Promise<void> {
    await this.db
      .update(notificationAlertStates)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(notificationAlertStates.id, stateId));

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

    const webhookIds = (rule.webhookIds ?? []) as string[];
    if (webhookIds.length > 0) {
      const webhooks = await this.webhookService.getRawByIds(webhookIds);
      for (const webhook of webhooks) {
        if (!webhook.enabled) continue;
        this.dispatcherService.dispatch(webhook, event).catch((err) => {
          logger.error('Resolve dispatch failed', { webhookId: webhook.id, ruleId: rule.id, error: err.message });
        });
      }
    }

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

    // Record notification time for cooldown
    await this.db.insert(notificationAlertStates).values({
      ruleId: rule.id,
      resourceType,
      resourceId: resourceKey,
      status: 'resolved',
      severity: rule.severity,
      context: details,
      resolvedAt: new Date(),
    });

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

    const webhookIds = (rule.webhookIds ?? []) as string[];
    if (webhookIds.length > 0) {
      const webhooks = await this.webhookService.getRawByIds(webhookIds);
      for (const webhook of webhooks) {
        if (!webhook.enabled) continue;
        this.dispatcherService.dispatch(webhook, event).catch((err) => {
          logger.error('Event alert dispatch failed', { webhookId: webhook.id, ruleId: rule.id, error: err.message });
        });
      }
    }

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
      rule.category === 'database_redis'
    ) {
      return sourceId;
    }
    return null;
  }
}
