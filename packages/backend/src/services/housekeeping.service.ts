import { readdir, stat } from 'node:fs/promises';
import httpModule from 'node:http';
import { join } from 'node:path';
import { and, count, eq, lt, min, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { alerts } from '@/db/schema/alerts.js';
import { auditLog } from '@/db/schema/audit-log.js';
import { nodes } from '@/db/schema/nodes.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AISandboxArtifactService } from '@/modules/ai/ai.sandbox-artifact.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import type { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import type { DockerService } from './docker.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';

const logger = createChildLogger('HousekeepingService');
const VOLUME_CLEANUP_PROTECTED_LABEL = 'gateway.housekeeping.protected';

// ── Types ───────────────────────────────────────────────────────────

export interface HousekeepingConfig {
  enabled: boolean;
  cronExpression: string;
  nginxLogs: { enabled: boolean; retentionDays: number };
  auditLog: { enabled: boolean; retentionDays: number };
  dismissedAlerts: { enabled: boolean; retentionDays: number };
  deliveryLog: { enabled: boolean; retentionDays: number };
  structuredLogs: { enabled: boolean; maxRows: number; maxSizeBytes: number };
  orphanedAIArtifacts: { enabled: boolean };
  gatewayLogs: { enabled: false };
  orphanedVolumes: { enabled: boolean; retentionDays: number };
  dockerPrune: { enabled: boolean };
  orphanedCerts: { enabled: boolean };
  acmeCleanup: { enabled: boolean };
}

export interface CategoryResult {
  category: string;
  success: boolean;
  itemsCleaned: number;
  spaceFreedBytes?: number;
  error?: string;
  durationMs: number;
}

export interface HousekeepingRunResult {
  startedAt: string;
  completedAt: string;
  trigger: 'scheduled' | 'manual';
  triggeredBy?: string;
  totalDurationMs: number;
  categories: CategoryResult[];
  overallSuccess: boolean;
}

export interface HousekeepingStats {
  nginxLogs: { totalSizeBytes: number; fileCount: number; oldestFile: string | null };
  auditLog: { totalRows: number; oldestEntry: string | null };
  dismissedAlerts: { count: number; oldestAlert: string | null };
  deliveryLog: { total: number; success: number; failed: number; retrying: number };
  structuredLogs: { totalRows: number; totalSizeBytes: number; status: string };
  clickHouseInternals: { totalRows: number; totalSizeBytes: number; status: string; capBytes: number };
  orphanedAIArtifacts: { count: number; totalSizeBytes: number };
  gatewayLogs: { totalSizeBytes: number; fileCount: number; available: false };
  orphanedVolumes: { count: number; reclaimableBytes: number };
  orphanedCerts: { count: number; certIds: string[] };
  acmeChallenges: { fileCount: number; totalSizeBytes: number };
  dockerImages: { oldImageCount: number; reclaimableBytes: number };
  lastRun: HousekeepingRunResult | null;
  isRunning: boolean;
}

// ── Settings Keys ───────────────────────────────────────────────────

const KEYS = {
  enabled: 'housekeeping:enabled',
  cron: 'housekeeping:cron',
  nginxLogsEnabled: 'housekeeping:nginx_logs:enabled',
  nginxLogsRetention: 'housekeeping:nginx_logs:retention_days',
  auditLogEnabled: 'housekeeping:audit_log:enabled',
  auditLogRetention: 'housekeeping:audit_log:retention_days',
  dismissedAlertsEnabled: 'housekeeping:dismissed_alerts:enabled',
  dismissedAlertsRetention: 'housekeeping:dismissed_alerts:retention_days',
  deliveryLogEnabled: 'housekeeping:delivery_log:enabled',
  deliveryLogRetention: 'housekeeping:delivery_log:retention_days',
  structuredLogsEnabled: 'housekeeping:structured_logs:enabled',
  structuredLogsMaxRows: 'housekeeping:structured_logs:max_rows',
  structuredLogsMaxSizeBytes: 'housekeeping:structured_logs:max_size_bytes',
  orphanedAIArtifactsEnabled: 'housekeeping:orphaned_ai_artifacts:enabled',
  orphanedVolumesEnabled: 'housekeeping:orphaned_volumes:enabled',
  orphanedVolumesRetention: 'housekeeping:orphaned_volumes:retention_days',
  dockerPruneEnabled: 'housekeeping:docker_prune:enabled',
  orphanedCertsEnabled: 'housekeeping:orphaned_certs:enabled',
  acmeCleanupEnabled: 'housekeeping:acme_cleanup:enabled',
  lastRunResult: 'housekeeping:last_run_result',
  runHistory: 'housekeeping:run_history',
} as const;

const DEFAULTS: Record<string, unknown> = {
  [KEYS.enabled]: true,
  [KEYS.cron]: '0 2 * * *',
  [KEYS.nginxLogsEnabled]: true,
  [KEYS.nginxLogsRetention]: 30,
  [KEYS.auditLogEnabled]: true,
  [KEYS.auditLogRetention]: 90,
  [KEYS.dismissedAlertsEnabled]: true,
  [KEYS.dismissedAlertsRetention]: 30,
  [KEYS.deliveryLogEnabled]: true,
  [KEYS.deliveryLogRetention]: 7,
  [KEYS.structuredLogsEnabled]: false,
  [KEYS.structuredLogsMaxRows]: 100_000,
  [KEYS.structuredLogsMaxSizeBytes]: 10 * 1024 * 1024 * 1024,
  [KEYS.orphanedAIArtifactsEnabled]: true,
  [KEYS.orphanedVolumesEnabled]: false,
  [KEYS.orphanedVolumesRetention]: 30,
  [KEYS.dockerPruneEnabled]: true,
  [KEYS.orphanedCertsEnabled]: false,
  [KEYS.acmeCleanupEnabled]: true,
};

const MAX_HISTORY = 20;

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ── Service ─────────────────────────────────────────────────────────

export class HousekeepingService {
  private running = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerService: DockerService,
    readonly _nodeDispatch: NodeDispatchService,
    readonly _env: Env
  ) {}

  // ── Config ──────────────────────────────────────────────────────

  async getConfig(): Promise<HousekeepingConfig> {
    const rows = await this.db.select().from(settings).where(sql`${settings.key} LIKE 'housekeeping:%'`);

    const map = new Map(rows.map((r) => [r.key, r.value]));
    const get = <T>(key: string, fallback: T): T => {
      const v = map.get(key);
      return v !== undefined && v !== null ? (v as T) : fallback;
    };

    return {
      enabled: get(KEYS.enabled, DEFAULTS[KEYS.enabled] as boolean),
      cronExpression: get(KEYS.cron, DEFAULTS[KEYS.cron] as string),
      nginxLogs: {
        enabled: get(KEYS.nginxLogsEnabled, DEFAULTS[KEYS.nginxLogsEnabled] as boolean),
        retentionDays: get(KEYS.nginxLogsRetention, DEFAULTS[KEYS.nginxLogsRetention] as number),
      },
      auditLog: {
        enabled: get(KEYS.auditLogEnabled, DEFAULTS[KEYS.auditLogEnabled] as boolean),
        retentionDays: get(KEYS.auditLogRetention, DEFAULTS[KEYS.auditLogRetention] as number),
      },
      dismissedAlerts: {
        enabled: get(KEYS.dismissedAlertsEnabled, DEFAULTS[KEYS.dismissedAlertsEnabled] as boolean),
        retentionDays: get(KEYS.dismissedAlertsRetention, DEFAULTS[KEYS.dismissedAlertsRetention] as number),
      },
      deliveryLog: {
        enabled: get(KEYS.deliveryLogEnabled, DEFAULTS[KEYS.deliveryLogEnabled] as boolean),
        retentionDays: get(KEYS.deliveryLogRetention, DEFAULTS[KEYS.deliveryLogRetention] as number),
      },
      structuredLogs: {
        enabled: get(KEYS.structuredLogsEnabled, DEFAULTS[KEYS.structuredLogsEnabled] as boolean),
        maxRows: get(KEYS.structuredLogsMaxRows, DEFAULTS[KEYS.structuredLogsMaxRows] as number),
        maxSizeBytes: get(KEYS.structuredLogsMaxSizeBytes, DEFAULTS[KEYS.structuredLogsMaxSizeBytes] as number),
      },
      orphanedAIArtifacts: {
        enabled: get(KEYS.orphanedAIArtifactsEnabled, DEFAULTS[KEYS.orphanedAIArtifactsEnabled] as boolean),
      },
      gatewayLogs: {
        enabled: false,
      },
      orphanedVolumes: {
        enabled: get(KEYS.orphanedVolumesEnabled, DEFAULTS[KEYS.orphanedVolumesEnabled] as boolean),
        retentionDays: get(KEYS.orphanedVolumesRetention, DEFAULTS[KEYS.orphanedVolumesRetention] as number),
      },
      dockerPrune: {
        enabled: get(KEYS.dockerPruneEnabled, DEFAULTS[KEYS.dockerPruneEnabled] as boolean),
      },
      orphanedCerts: {
        enabled: get(KEYS.orphanedCertsEnabled, DEFAULTS[KEYS.orphanedCertsEnabled] as boolean),
      },
      acmeCleanup: {
        enabled: get(KEYS.acmeCleanupEnabled, DEFAULTS[KEYS.acmeCleanupEnabled] as boolean),
      },
    };
  }

  async updateConfig(partial: DeepPartial<HousekeepingConfig>): Promise<HousekeepingConfig> {
    const updates: Array<[string, unknown]> = [];

    if (partial.enabled !== undefined) updates.push([KEYS.enabled, partial.enabled]);
    if (partial.cronExpression !== undefined) updates.push([KEYS.cron, partial.cronExpression]);
    if (partial.nginxLogs?.enabled !== undefined) updates.push([KEYS.nginxLogsEnabled, partial.nginxLogs.enabled]);
    if (partial.nginxLogs?.retentionDays !== undefined)
      updates.push([KEYS.nginxLogsRetention, partial.nginxLogs.retentionDays]);
    if (partial.auditLog?.enabled !== undefined) updates.push([KEYS.auditLogEnabled, partial.auditLog.enabled]);
    if (partial.auditLog?.retentionDays !== undefined)
      updates.push([KEYS.auditLogRetention, partial.auditLog.retentionDays]);
    if (partial.dismissedAlerts?.enabled !== undefined)
      updates.push([KEYS.dismissedAlertsEnabled, partial.dismissedAlerts.enabled]);
    if (partial.dismissedAlerts?.retentionDays !== undefined)
      updates.push([KEYS.dismissedAlertsRetention, partial.dismissedAlerts.retentionDays]);
    if (partial.deliveryLog?.enabled !== undefined)
      updates.push([KEYS.deliveryLogEnabled, partial.deliveryLog.enabled]);
    if (partial.deliveryLog?.retentionDays !== undefined)
      updates.push([KEYS.deliveryLogRetention, partial.deliveryLog.retentionDays]);
    if (partial.structuredLogs?.enabled !== undefined)
      updates.push([KEYS.structuredLogsEnabled, partial.structuredLogs.enabled]);
    if (partial.structuredLogs?.maxRows !== undefined)
      updates.push([KEYS.structuredLogsMaxRows, partial.structuredLogs.maxRows]);
    if (partial.structuredLogs?.maxSizeBytes !== undefined)
      updates.push([KEYS.structuredLogsMaxSizeBytes, partial.structuredLogs.maxSizeBytes]);
    if (partial.orphanedAIArtifacts?.enabled !== undefined)
      updates.push([KEYS.orphanedAIArtifactsEnabled, partial.orphanedAIArtifacts.enabled]);
    if (partial.orphanedVolumes?.enabled !== undefined)
      updates.push([KEYS.orphanedVolumesEnabled, partial.orphanedVolumes.enabled]);
    if (partial.orphanedVolumes?.retentionDays !== undefined)
      updates.push([KEYS.orphanedVolumesRetention, partial.orphanedVolumes.retentionDays]);
    if (partial.dockerPrune?.enabled !== undefined)
      updates.push([KEYS.dockerPruneEnabled, partial.dockerPrune.enabled]);
    if (partial.orphanedCerts?.enabled !== undefined)
      updates.push([KEYS.orphanedCertsEnabled, partial.orphanedCerts.enabled]);
    if (partial.acmeCleanup?.enabled !== undefined)
      updates.push([KEYS.acmeCleanupEnabled, partial.acmeCleanup.enabled]);

    await this.db.transaction(async (tx) => {
      for (const [key, value] of updates) {
        await tx
          .insert(settings)
          .values({ key, value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
      }
    });

    return this.getConfig();
  }

  // ── Stats ───────────────────────────────────────────────────────

  async getStats(): Promise<HousekeepingStats> {
    const [
      nginxLogs,
      auditLogStats,
      alertStats,
      deliveryLog,
      clickHouse,
      orphanedAIArtifacts,
      gatewayLogs,
      orphanedVolumes,
      orphanedCerts,
      acme,
      docker,
      lastRun,
    ] = await Promise.all([
      this.getNginxLogStats(),
      this.getAuditLogStats(),
      this.getDismissedAlertStats(),
      this.getDeliveryLogStats(),
      Promise.resolve(this.loggingMaintenanceService?.getSnapshot() ?? null),
      this.getOrphanedAIArtifactStats(),
      this.getGatewayLogStats(),
      this.getOrphanedVolumeStats(),
      this.getOrphanedCertStats(),
      this.getAcmeChallengeStats(),
      this.getDockerImageStats(),
      this.getLastRunResult(),
    ]);

    return {
      nginxLogs,
      auditLog: auditLogStats,
      dismissedAlerts: alertStats,
      deliveryLog,
      structuredLogs: {
        totalRows: clickHouse?.structured.rows ?? 0,
        totalSizeBytes: clickHouse?.structured.bytes ?? 0,
        status: clickHouse?.status ?? 'disabled',
      },
      clickHouseInternals: {
        totalRows: clickHouse?.internal.rows ?? 0,
        totalSizeBytes: clickHouse?.internal.bytes ?? 0,
        status: clickHouse?.status ?? 'disabled',
        capBytes: clickHouse?.internal.capBytes ?? 0,
      },
      orphanedAIArtifacts,
      gatewayLogs,
      orphanedVolumes,
      orphanedCerts,
      acmeChallenges: acme,
      dockerImages: docker,
      lastRun,
      isRunning: this.running,
    };
  }

  // ── Run All ─────────────────────────────────────────────────────

  async runAll(trigger: 'scheduled' | 'manual', userId?: string): Promise<HousekeepingRunResult> {
    if (this.running) {
      throw new Error('Housekeeping is already running');
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    const categories: CategoryResult[] = [];

    try {
      const config = await this.getConfig();

      if (config.nginxLogs.enabled) {
        categories.push(
          await this.runCategory('Nginx Logs', () => this.rotateNginxLogs(config.nginxLogs.retentionDays))
        );
      }
      if (config.auditLog.enabled) {
        categories.push(await this.runCategory('Audit Log', () => this.cleanAuditLog(config.auditLog.retentionDays)));
      }
      if (config.dismissedAlerts.enabled) {
        categories.push(
          await this.runCategory('Dismissed Alerts', () =>
            this.cleanDismissedAlerts(config.dismissedAlerts.retentionDays)
          )
        );
      }
      if (config.deliveryLog.enabled) {
        categories.push(
          await this.runCategory('Delivery Log', () => this.cleanDeliveryLog(config.deliveryLog.retentionDays))
        );
      }
      if (config.structuredLogs.enabled) {
        categories.push(
          await this.runCategory('Structured Logs', () => this.cleanStructuredLogs(config.structuredLogs))
        );
      }
      if (config.orphanedAIArtifacts.enabled) {
        categories.push(await this.runCategory('Orphaned AI Artifacts', () => this.cleanOrphanedAIArtifacts()));
      }
      if (config.orphanedVolumes.enabled) {
        categories.push(
          await this.runCategory('Orphaned Volumes', () =>
            this.cleanOrphanedVolumes(config.orphanedVolumes.retentionDays, userId ?? null)
          )
        );
      }
      if (config.orphanedCerts.enabled) {
        categories.push(await this.runCategory('Orphaned Certs', () => this.cleanOrphanedCerts()));
      }
      if (config.acmeCleanup.enabled) {
        categories.push(await this.runCategory('ACME Challenges', () => this.cleanAcmeChallenges()));
      }
      if (config.dockerPrune.enabled) {
        categories.push(await this.runCategory('Docker Images', () => this.pruneDockerImages()));
      }

      const completedAt = new Date().toISOString();
      const result: HousekeepingRunResult = {
        startedAt,
        completedAt,
        trigger,
        triggeredBy: userId,
        totalDurationMs: Date.now() - new Date(startedAt).getTime(),
        categories,
        overallSuccess: categories.every((c) => c.success),
      };

      await this.saveRunResult(result);
      logger.info('Housekeeping completed', {
        trigger,
        durationMs: result.totalDurationMs,
        categories: categories.length,
        success: result.overallSuccess,
      });

      return result;
    } finally {
      this.running = false;
    }
  }

  async getRunHistory(): Promise<HousekeepingRunResult[]> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.runHistory)).limit(1);
    if (!row.length) return [];
    return (row[0].value as HousekeepingRunResult[]) || [];
  }

  // ── Category Implementations ────────────────────────────────────

  private async rotateNginxLogs(_retentionDays: number): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    // Log rotation is handled by each daemon node locally (7-day retention).
    // Logs streamed to Gateway are stored in the database / log aggregation.
    logger.debug('Nginx log rotation is managed by daemon nodes');
    return { itemsCleaned: 0 };
  }

  private async cleanAuditLog(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);

    const result = await this.db
      .delete(auditLog)
      .where(lt(auditLog.createdAt, threshold))
      .returning({ id: auditLog.id });

    return { itemsCleaned: result.length };
  }

  private async cleanDismissedAlerts(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);

    const result = await this.db
      .delete(alerts)
      .where(and(eq(alerts.dismissed, true), lt(alerts.createdAt, threshold)))
      .returning({ id: alerts.id });

    return { itemsCleaned: result.length };
  }

  private notifDeliveryService?: NotificationDeliveryService;
  setNotifDeliveryService(svc: NotificationDeliveryService) {
    this.notifDeliveryService = svc;
  }

  private loggingMaintenanceService?: LoggingMaintenanceService;
  setLoggingMaintenanceService(svc: LoggingMaintenanceService) {
    this.loggingMaintenanceService = svc;
  }

  private sandboxArtifactService?: AISandboxArtifactService;
  setSandboxArtifactService(svc: AISandboxArtifactService) {
    this.sandboxArtifactService = svc;
  }

  private dockerManagementService?: DockerManagementService;
  setDockerManagementService(svc: DockerManagementService) {
    this.dockerManagementService = svc;
  }

  private async cleanDeliveryLog(retentionDays: number): Promise<{ itemsCleaned: number }> {
    if (!this.notifDeliveryService) return { itemsCleaned: 0 };
    const count = await this.notifDeliveryService.cleanOldEntries(retentionDays);
    return { itemsCleaned: count };
  }

  private async cleanStructuredLogs(config: HousekeepingConfig['structuredLogs']) {
    if (!this.loggingMaintenanceService) return { itemsCleaned: 0, spaceFreedBytes: 0 };
    return this.loggingMaintenanceService.cleanupStructuredLogsAndRefresh(config);
  }

  private async cleanOrphanedAIArtifacts(): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    if (!this.sandboxArtifactService) return { itemsCleaned: 0 };
    return this.sandboxArtifactService.cleanOrphanedArtifacts();
  }

  private async cleanOrphanedVolumes(
    retentionDays: number,
    userId: string | null
  ): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    if (!this.dockerManagementService) return { itemsCleaned: 0 };
    const candidates = await this.findOrphanedVolumes(retentionDays);
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;

    for (const candidate of candidates) {
      try {
        await this.dockerManagementService.removeVolume(candidate.nodeId, candidate.name, false, userId);
        itemsCleaned += 1;
        spaceFreedBytes += candidate.sizeBytes ?? 0;
      } catch (error) {
        logger.warn('Failed to remove orphaned Docker volume', {
          nodeId: candidate.nodeId,
          name: candidate.name,
          error,
        });
      }
    }

    return { itemsCleaned, spaceFreedBytes };
  }

  private async cleanOrphanedCerts(): Promise<{ itemsCleaned: number }> {
    // Cert files are managed by daemon nodes. Orphan cleanup is a daemon-side concern.
    logger.debug('Orphaned cert cleanup is managed by daemon nodes');
    return { itemsCleaned: 0 };
  }

  private async cleanAcmeChallenges(): Promise<{ itemsCleaned: number }> {
    // ACME challenge files are managed by daemon nodes.
    logger.debug('ACME challenge cleanup is managed by daemon nodes');
    return { itemsCleaned: 0 };
  }

  private async pruneDockerImages(): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    try {
      // Get current running image
      const selfInfo = await this.dockerService.inspectSelf();
      const currentImage = selfInfo.Config.Image;
      const imageBase = currentImage.includes(':')
        ? currentImage.substring(0, currentImage.lastIndexOf(':'))
        : currentImage;

      // List all images
      const listRes = await this.dockerRequest('GET', `/images/json`);
      if (listRes.statusCode !== 200) return { itemsCleaned: 0 };

      const images = JSON.parse(listRes.body) as Array<{
        Id: string;
        RepoTags: string[] | null;
        Size: number;
      }>;

      let cleaned = 0;
      let freedBytes = 0;

      for (const img of images) {
        const tags = img.RepoTags || [];
        // Only consider gateway images
        const isGatewayImage = tags.some((t) => t.startsWith(`${imageBase}:`));
        if (!isGatewayImage) continue;

        // Don't remove the currently running image
        const isCurrentImage = tags.some((t) => t === currentImage);
        if (isCurrentImage) continue;

        try {
          const delRes = await this.dockerRequest('DELETE', `/images/${encodeURIComponent(img.Id)}`);
          if (delRes.statusCode === 200) {
            cleaned++;
            freedBytes += img.Size;
          }
        } catch {
          // ignore individual failures
        }
      }

      // Also clean up stopped sidecar containers
      const labels = selfInfo.Config.Labels;
      const composeProject = labels['com.docker.compose.project'];
      if (composeProject) {
        const filters = JSON.stringify({
          status: ['exited'],
          label: [`com.docker.compose.project=${composeProject}`],
        });
        const containerRes = await this.dockerRequest(
          'GET',
          `/containers/json?all=true&filters=${encodeURIComponent(filters)}`
        );
        if (containerRes.statusCode === 200) {
          const containers = JSON.parse(containerRes.body) as Array<{ Id: string; Names: string[] }>;
          for (const c of containers) {
            try {
              await this.dockerService.removeContainer(c.Id);
              cleaned++;
            } catch {
              // ignore
            }
          }
        }
      }

      return { itemsCleaned: cleaned, spaceFreedBytes: freedBytes };
    } catch (error) {
      logger.warn('Docker pruning failed', { error });
      return { itemsCleaned: 0 };
    }
  }

  // ── Stats Helpers ───────────────────────────────────────────────

  private async getNginxLogStats(): Promise<HousekeepingStats['nginxLogs']> {
    // Logs are managed by daemon nodes (7-day local retention) and streamed to Gateway
    const logsPath = '/var/log/gateway-logs'; // Gateway-side log storage (future)
    try {
      const entries = await readdir(logsPath);
      let totalSize = 0;
      let fileCount = 0;
      let oldestMtime: Date | null = null;
      let oldestName: string | null = null;

      for (const entry of entries) {
        try {
          const s = await stat(join(logsPath, entry));
          if (!s.isFile()) continue;
          fileCount++;
          totalSize += s.size;
          if (!oldestMtime || s.mtime < oldestMtime) {
            oldestMtime = s.mtime;
            oldestName = entry;
          }
        } catch {
          // skip unreadable files
        }
      }

      return { totalSizeBytes: totalSize, fileCount, oldestFile: oldestName };
    } catch {
      return { totalSizeBytes: 0, fileCount: 0, oldestFile: null };
    }
  }

  private async getAuditLogStats(): Promise<HousekeepingStats['auditLog']> {
    const [countResult] = await this.db.select({ total: count() }).from(auditLog);
    const [oldestResult] = await this.db.select({ oldest: min(auditLog.createdAt) }).from(auditLog);
    return {
      totalRows: countResult?.total ?? 0,
      oldestEntry: oldestResult?.oldest?.toISOString() ?? null,
    };
  }

  private async getDismissedAlertStats(): Promise<HousekeepingStats['dismissedAlerts']> {
    const [countResult] = await this.db.select({ total: count() }).from(alerts).where(eq(alerts.dismissed, true));
    const [oldestResult] = await this.db
      .select({ oldest: min(alerts.createdAt) })
      .from(alerts)
      .where(eq(alerts.dismissed, true));
    return {
      count: countResult?.total ?? 0,
      oldestAlert: oldestResult?.oldest?.toISOString() ?? null,
    };
  }

  private async getDeliveryLogStats(): Promise<HousekeepingStats['deliveryLog']> {
    if (!this.notifDeliveryService) return { total: 0, success: 0, failed: 0, retrying: 0 };
    return this.notifDeliveryService.getStats();
  }

  private async getOrphanedAIArtifactStats(): Promise<HousekeepingStats['orphanedAIArtifacts']> {
    if (!this.sandboxArtifactService) return { count: 0, totalSizeBytes: 0 };
    return this.sandboxArtifactService.getOrphanedStats();
  }

  private async getGatewayLogStats(): Promise<HousekeepingStats['gatewayLogs']> {
    return { totalSizeBytes: 0, fileCount: 0, available: false };
  }

  private async getOrphanedVolumeStats(): Promise<HousekeepingStats['orphanedVolumes']> {
    const config = await this.getConfig();
    const candidates = await this.findOrphanedVolumes(config.orphanedVolumes.retentionDays);
    return {
      count: candidates.length,
      reclaimableBytes: candidates.reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0),
    };
  }

  private async getOrphanedCertStats(): Promise<HousekeepingStats['orphanedCerts']> {
    // Cert files are on daemon nodes, not accessible from Gateway
    return { count: 0, certIds: [] };
  }

  private async getAcmeChallengeStats(): Promise<HousekeepingStats['acmeChallenges']> {
    // ACME challenge files are on daemon nodes, not accessible from Gateway
    return { fileCount: 0, totalSizeBytes: 0 };
  }

  private async getDockerImageStats(): Promise<HousekeepingStats['dockerImages']> {
    try {
      const selfInfo = await this.dockerService.inspectSelf();
      const currentImage = selfInfo.Config.Image;
      const imageBase = currentImage.includes(':')
        ? currentImage.substring(0, currentImage.lastIndexOf(':'))
        : currentImage;

      const res = await this.dockerRequest('GET', '/images/json');
      if (res.statusCode !== 200) return { oldImageCount: 0, reclaimableBytes: 0 };

      const images = JSON.parse(res.body) as Array<{
        Id: string;
        RepoTags: string[] | null;
        Size: number;
      }>;

      let oldCount = 0;
      let reclaimable = 0;

      for (const img of images) {
        const tags = img.RepoTags || [];
        const isGateway = tags.some((t) => t.startsWith(`${imageBase}:`));
        if (!isGateway) continue;
        const isCurrent = tags.some((t) => t === currentImage);
        if (isCurrent) continue;
        oldCount++;
        reclaimable += img.Size;
      }

      return { oldImageCount: oldCount, reclaimableBytes: reclaimable };
    } catch {
      return { oldImageCount: 0, reclaimableBytes: 0 };
    }
  }

  private async findOrphanedVolumes(
    retentionDays: number
  ): Promise<Array<{ nodeId: string; name: string; sizeBytes?: number }>> {
    const dockerNodes = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'docker'), eq(nodes.status, 'online')));
    const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const candidates: Array<{ nodeId: string; name: string; sizeBytes?: number }> = [];
    if (!this.dockerManagementService) return candidates;

    for (const node of dockerNodes) {
      let volumes: unknown;
      try {
        volumes = await this.dockerManagementService.listVolumes(node.id);
      } catch (error) {
        logger.debug('Failed to list Docker volumes for housekeeping', { nodeId: node.id, error });
        continue;
      }

      if (!Array.isArray(volumes)) continue;
      for (const volume of volumes) {
        const candidate = normalizeHousekeepingVolume(volume);
        if (!candidate) continue;
        if (!isAnonymousDockerVolumeName(candidate.name)) continue;
        if (candidate.usedBy.length > 0 || candidate.usedByCount > 0) continue;
        if (candidate.labels[VOLUME_CLEANUP_PROTECTED_LABEL] === 'true') continue;
        const createdAtMs = candidate.createdAt ? Date.parse(candidate.createdAt) : Number.NaN;
        if (!Number.isFinite(createdAtMs) || createdAtMs > threshold) continue;
        candidates.push({ nodeId: node.id, name: candidate.name, sizeBytes: candidate.sizeBytes });
      }
    }

    return candidates;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async runCategory(
    name: string,
    fn: () => Promise<{ itemsCleaned: number; spaceFreedBytes?: number }>
  ): Promise<CategoryResult> {
    const start = Date.now();
    try {
      const result = await fn();
      return {
        category: name,
        success: true,
        itemsCleaned: result.itemsCleaned,
        spaceFreedBytes: result.spaceFreedBytes,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      logger.warn(`Housekeeping category "${name}" failed`, { error });
      return {
        category: name,
        success: false,
        itemsCleaned: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    }
  }

  private async getLastRunResult(): Promise<HousekeepingRunResult | null> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.lastRunResult)).limit(1);
    if (!row.length) return null;
    return (row[0].value as HousekeepingRunResult) || null;
  }

  private async saveRunResult(result: HousekeepingRunResult): Promise<void> {
    await this.upsertSetting(KEYS.lastRunResult, result);

    // Append to history (keep last N)
    const history = await this.getRunHistory();
    history.unshift(result);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await this.upsertSetting(KEYS.runHistory, history);
  }

  private async upsertSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  /** Direct Docker API request (for image listing etc.) */
  private dockerRequest(method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      const req = httpModule.request(
        {
          socketPath: '/var/run/docker.sock',
          method,
          path: `/v1.46${path}`,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
          res.on('error', reject);
        }
      );

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function isAnonymousDockerVolumeName(name: string): boolean {
  return /^[a-f0-9]{64}$/i.test(name);
}

function normalizeHousekeepingVolume(volume: unknown): {
  name: string;
  labels: Record<string, string>;
  createdAt: string | null;
  usedBy: string[];
  usedByCount: number;
  sizeBytes?: number;
} | null {
  if (!volume || typeof volume !== 'object') return null;
  const record = volume as Record<string, unknown>;
  const name = record.name ?? record.Name;
  if (typeof name !== 'string' || !name) return null;

  const labels = (record.labels ?? record.Labels ?? {}) as Record<string, string>;
  const usedBy = record.usedBy ?? record.UsedBy;
  const usageData = record.usageData ?? record.UsageData;
  const usageRecord = usageData && typeof usageData === 'object' ? (usageData as Record<string, unknown>) : null;
  const size = usageRecord?.Size ?? usageRecord?.size;
  const createdAt = record.createdAt ?? record.CreatedAt;

  return {
    name,
    labels: labels && typeof labels === 'object' ? labels : {},
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    usedBy: Array.isArray(usedBy) ? usedBy.filter((item): item is string => typeof item === 'string') : [],
    usedByCount:
      typeof record.usedByCount === 'number'
        ? record.usedByCount
        : typeof record.UsedByCount === 'number'
          ? record.UsedByCount
          : Array.isArray(usedBy)
            ? usedBy.length
            : 0,
    sizeBytes: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : undefined,
  };
}
