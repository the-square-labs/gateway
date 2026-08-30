import 'reflect-metadata';
import type { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { ACMERenewalJob } from '@/jobs/acme-renewal.job.js';
import { DaemonUpdateCheckJob } from '@/jobs/daemon-update-check.job.js';
import { DnsCheckJob } from '@/jobs/dns-check.job.js';
import { ExpiryAlertJob } from '@/jobs/expiry-alert.job.js';
import { HealthCheckJob } from '@/jobs/health-check.job.js';
import { HousekeepingJob } from '@/jobs/housekeeping.job.js';
import { NotificationRetryJob } from '@/jobs/notification-retry.job.js';
import { SiemDeliveryJob } from '@/jobs/siem-delivery.job.js';
import { UpdateCheckJob } from '@/jobs/update-check.job.js';
import { logger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import { DockerBuildRunnerService } from '@/modules/docker/docker-build-runner.service.js';
import { DockerHealthCheckService } from '@/modules/docker/docker-health-check.service.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { detectPublicIP, initDnsResolver } from '@/modules/domains/dns.utils.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LICENSE_SCHEDULER_INTERVAL_MS } from '@/modules/license/license.types.js';
import { LicenseEntitlementReconcilerService } from '@/modules/license/license-entitlement-reconciler.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { NODE_MONITORING_CADENCE_MS } from '@/modules/nodes/node-monitoring.service.js';
import { NotificationAlertRuleService } from '@/modules/notifications/notification-alert-rule.service.js';
import { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import { NotificationDispatcherService } from '@/modules/notifications/notification-dispatcher.service.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { NotificationWebhookService } from '@/modules/notifications/notification-webhook.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PageMaintenanceService } from '@/modules/pages/retention/page-maintenance.service.js';
import { PageRouteService } from '@/modules/pages/routes/page-route.service.js';
import { TemplatesService } from '@/modules/pki/templates.service.js';
import { AdditionalRouteService } from '@/modules/proxy/additional-route.service.js';
import { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { StatusIncidentEvaluatorService } from '@/modules/status-page/status-incident-evaluator.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { CacheService } from '@/services/cache.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import { UpdateService } from '@/services/update.service.js';

export async function initializeBackgroundServices(): Promise<void> {
  const env = container.resolve<ReturnType<typeof getEnv>>(TOKENS.Env);
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const notifRuleService = container.resolve(NotificationAlertRuleService);
  const notifWebhookService = container.resolve(NotificationWebhookService);
  const notifDispatcherService = container.resolve(NotificationDispatcherService);
  const cacheService = container.resolve(CacheService);
  const nodeRegistry = container.resolve(NodeRegistryService);
  const loggingEnvironmentService = container.resolve(LoggingEnvironmentService);
  const loggingClickHouseService = container.resolve(LoggingClickHouseService);
  const dockerManagementService = container.resolve(DockerManagementService);
  const dockerHealthCheckService = container.resolve(DockerHealthCheckService);
  const databaseMonitoringService = container.resolve(DatabaseMonitoringService);
  const proxyService = container.resolve(ProxyService);
  const licenseEntitlementReconciler = container.resolve(LicenseEntitlementReconcilerService);
  const housekeepingService = container.resolve(HousekeepingService);
  const notifDeliveryService = container.resolve(NotificationDeliveryService);
  const siemDeliveryService = container.resolve(SiemDeliveryService);
  const templatesService = container.resolve(TemplatesService);
  const nginxTemplateService = container.resolve(NginxTemplateService);
  const relayPolicyService = container.isRegistered(RelayPolicyService)
    ? container.resolve(RelayPolicyService)
    : undefined;
  const relayPoolService = container.isRegistered(RelayPoolService) ? container.resolve(RelayPoolService) : undefined;
  const systemCertificateLifecycleService = container.resolve(SystemCertificateLifecycleService);
  const nginxCertificateDistribution = container.resolve(NginxCertificateDistributionService);
  const sslService = container.resolve(SSLService);
  const alertService = container.resolve(AlertService);
  const nodeDispatch = container.resolve(NodeDispatchService);
  const domainsService = container.resolve(DomainsService);
  const additionalRouteService = container.resolve(AdditionalRouteService);
  const dockerBuildService = container.resolve(DockerBuildService);
  const dockerBuildRunnerService = container.isRegistered(DockerBuildRunnerService)
    ? container.resolve(DockerBuildRunnerService)
    : undefined;
  const dockerSourceService = container.resolve(DockerSourceService);
  const dockerInternalRegistryService = container.resolve(DockerInternalRegistryService);
  const managedDatabaseService = container.resolve(ManagedDatabaseService);
  const dockerSnapshotReconciler = container.resolve(DockerSnapshotReconciler);
  const dockerSnapshotService = container.resolve(DockerSnapshotService);
  const pageMaintenanceService = container.resolve(PageMaintenanceService);
  const pageProfileService = container.resolve(PageProfileService);
  const pageRouteService = container.resolve(PageRouteService);
  const updateService = container.resolve(UpdateService);
  const eventBus = container.resolve(EventBusService);
  const licenseService = container.resolve(LicenseService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const daemonUpdateService = container.resolve(DaemonUpdateService);
  const loggingMaintenanceService = container.resolve(LoggingMaintenanceService);
  const statusPageService = container.resolve(StatusPageService);
  const integrationsService = container.resolve(IntegrationsService);
  const externalSshService = container.resolve(ExternalSshService);
  const readModelCoordinator = container.resolve(ReadModelCoordinator);

  // Configure DNS resolvers and detect public IP
  initDnsResolver(
    env.DNS_RESOLVERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  await detectPublicIP(env.PUBLIC_IPV4, env.PUBLIC_IPV6);

  const notifEvaluatorService = new NotificationEvaluatorService(
    db,
    notifRuleService,
    notifWebhookService,
    notifDispatcherService,
    cacheService,
    nodeRegistry
  );
  notifEvaluatorService.setEventBus(eventBus);
  notifEvaluatorService.setLoggingServices(loggingEnvironmentService, loggingClickHouseService);
  dockerManagementService.setEvaluator(notifEvaluatorService);
  dockerHealthCheckService.setEvaluator(notifEvaluatorService);
  databaseMonitoringService.setEvaluator(notifEvaluatorService);
  databaseMonitoringService.setEventBus(eventBus);
  nodeRegistry.setEvaluator(notifEvaluatorService);
  proxyService.setEvaluator(notifEvaluatorService);
  notifEvaluatorService.start();
  databaseMonitoringService.start();
  container.registerInstance(NotificationEvaluatorService, notifEvaluatorService);
  await licenseEntitlementReconciler.start();

  housekeepingService.setNotifDeliveryService(notifDeliveryService);
  housekeepingService.setSiemDeliveryService(siemDeliveryService);

  // Seed built-in templates
  await templatesService.seedBuiltinTemplates();
  await nginxTemplateService.seedBuiltinTemplates();

  // Background jobs
  const scheduler = new SchedulerService();
  container.registerInstance(SchedulerService, scheduler);
  scheduler.registerInterval('system-certificate-crl-retry', 5 * 60 * 1000, async () => {
    await systemCertificateLifecycleService.retryPendingCRLs();
  });
  if (relayPolicyService) {
    scheduler.registerInterval('relay-policy-sync', 30_000, () =>
      relayPolicyService!.reconcileAndSync().then(() => undefined)
    );
    scheduler.registerInterval('relay-grant-refresh', 15 * 60 * 1000, () =>
      relayPolicyService!.refreshAllNodeGrantsIfDue().then(() => undefined)
    );
    scheduler.registerInterval('relay-signing-key-rotation', 60 * 60 * 1000, () =>
      relayPolicyService!.rotateIfDue().then(() => undefined)
    );
    scheduler.registerInterval('relay-pool-policy-lease-refresh', 5 * 60 * 1000, () =>
      relayPoolService!.refreshRemotePolicies()
    );
    // Same baseline cadence as ordinary node monitoring. Link Runtime pages
    // add focused 2s samples, but history does not depend on a page being open.
    scheduler.registerInterval('secure-link-runtime-monitoring', NODE_MONITORING_CADENCE_MS.background, () =>
      proxyService.collectSecureLinkRuntimeSnapshots()
    );
  }
  scheduler.registerInterval('nginx-tls-certificate-integrity', 6 * 60 * 60 * 1000, async () => {
    await nginxCertificateDistribution.reconcileIntegrity();
    await nginxCertificateDistribution.cleanupDueReplicas();
  });

  const acmeRenewalJob = new ACMERenewalJob(db, sslService, alertService);
  acmeRenewalJob.setEventBus(eventBus);
  const healthCheckJob = new HealthCheckJob(db, nodeDispatch);
  healthCheckJob.setEventBus(eventBus);
  healthCheckJob.setEvaluator(notifEvaluatorService);
  const expiryAlertJob = new ExpiryAlertJob(db, alertService);
  expiryAlertJob.setEventBus(eventBus);

  const dnsCheckJob = new DnsCheckJob(domainsService);
  scheduler.registerInterval('dns-check', env.DNS_CHECK_INTERVAL_SECONDS * 1000, () => dnsCheckJob.run());

  scheduler.register('acme-renewal', env.ACME_RENEWAL_CRON, () => acmeRenewalJob.run());
  // Scan at the minimum supported per-host cadence; the job itself evaluates
  // each host's configured interval and skips hosts that are not due.
  scheduler.registerInterval('health-check', Math.min(Math.max(env.HEALTH_CHECK_INTERVAL_SECONDS, 1), 5) * 1000, () =>
    healthCheckJob.run()
  );
  scheduler.registerInterval('proxy-maintenance-alerts', env.HEALTH_CHECK_INTERVAL_SECONDS * 1000, () =>
    notifEvaluatorService.reconcileProxyMaintenance()
  );
  scheduler.registerInterval('docker-health-check', 10000, () => dockerHealthCheckService.runDueChecks());
  scheduler.registerInterval('docker-build-lease-recovery', 15000, async () => {
    await dockerBuildService.recoverExpiredLeases();
  });
  if (dockerBuildRunnerService) {
    scheduler.registerInterval('docker-build-runner', 5000, () => dockerBuildRunnerService.reconcile());
  }
  const runDockerSourceAutomation = async (task: () => Promise<unknown>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      if (error instanceof AppError && error.code === 'LICENSE_ENTITLEMENT_REQUIRED') return;
      throw error;
    }
  };
  scheduler.registerInterval('docker-source-poll', 60_000, async () => {
    await runDockerSourceAutomation(() => dockerSourceService.pollDue());
  });
  scheduler.registerInterval('docker-source-webhooks', 15 * 60_000, async () => {
    await runDockerSourceAutomation(() => dockerSourceService.reconcileWebhooks());
  });
  scheduler.registerInterval('docker-internal-registry-health', 10_000, async () => {
    await dockerInternalRegistryService.probeHealth();
  });
  scheduler.registerInterval('managed-database-reconcile', 30000, () =>
    managedDatabaseService.reconcilePendingOperations()
  );
  scheduler.registerInterval('docker-snapshot-containers', 10000, async () => {
    dockerSnapshotReconciler.enqueueConnected('containers');
  });
  scheduler.registerInterval('docker-snapshot-inventory', 60000, async () => {
    dockerSnapshotReconciler.enqueueConnected('images');
    dockerSnapshotReconciler.enqueueConnected('volumes');
    dockerSnapshotReconciler.enqueueConnected('networks');
  });
  scheduler.registerInterval('docker-snapshot-details', 5000, () => dockerSnapshotReconciler.enqueueDueDetails());
  scheduler.registerInterval('docker-snapshot-housekeeping', 60 * 60 * 1000, () =>
    dockerSnapshotService.purgeOrphans()
  );
  scheduler.registerInterval('pages-maintenance', 15 * 60 * 1000, async () => {
    await pageMaintenanceService.run();
  });
  scheduler.registerInterval('pages-profile-reconcile', 60 * 1000, async () => {
    await pageProfileService.reconcile();
  });
  scheduler.registerInterval('pages-route-reconcile', 60 * 1000, async () => {
    await pageRouteService.reconcile();
  });
  scheduler.registerInterval('additional-route-reconcile', 60 * 1000, async () => {
    await additionalRouteService.reconcile();
  });
  scheduler.register('expiry-alerts', env.EXPIRY_CHECK_CRON, async () => {
    await Promise.all([expiryAlertJob.run(), notifEvaluatorService.evaluateCertificateExpiry()]);
  });

  const updateCheckJob = new UpdateCheckJob(updateService, eventBus);
  scheduler.registerInterval('update-check', env.UPDATE_CHECK_INTERVAL_HOURS * 3_600_000, () => updateCheckJob.run());
  setTimeout(() => void updateCheckJob.run(), 0);
  scheduler.registerInterval('license-heartbeat', LICENSE_SCHEDULER_INTERVAL_MS, () => licenseService.heartbeat());

  const daemonUpdateCheckJob = new DaemonUpdateCheckJob(daemonUpdateService);
  scheduler.registerInterval('daemon-update-check', env.UPDATE_CHECK_INTERVAL_HOURS * 3_600_000, () =>
    daemonUpdateCheckJob.run()
  );

  const housekeepingJob = new HousekeepingJob(housekeepingService);
  const hkConfig = await housekeepingService.getConfig();
  scheduler.register('housekeeping', hkConfig.cronExpression, () => housekeepingJob.run());
  scheduler.registerInterval('clickhouse-health-guard', 5 * 60 * 1000, async () => {
    const config = await housekeepingService.getConfig();
    await loggingMaintenanceService.runGuard(
      config.enabled ? config.structuredLogs : undefined,
      config.enabled ? config.clickHouseInternals : undefined
    );
    await notifEvaluatorService.evaluateLoggingRatios();
  });

  // Stale node detection (every 60 seconds) + missed health report detection (every 30 seconds)
  scheduler.registerInterval('stale-node-check', 60000, () => nodeRegistry.markStaleNodesOffline());
  scheduler.registerInterval('node-health-record', 30000, () => nodeRegistry.recordHealthChecks());

  const statusIncidentEvaluator = new StatusIncidentEvaluatorService(db, statusPageService);
  container.registerInstance(StatusIncidentEvaluatorService, statusIncidentEvaluator);
  scheduler.registerInterval('status-page-incidents', 30000, () => statusIncidentEvaluator.run());

  // Notification webhook retry job (every 30 seconds)
  const notifRetryJob = new NotificationRetryJob(notifDeliveryService, notifDispatcherService);
  scheduler.registerInterval('notification-retry', 30000, () => notifRetryJob.run());
  const siemDeliveryJob = new SiemDeliveryJob(siemDeliveryService, generalSettingsService);
  scheduler.registerInterval('siem-delivery', 30000, () => siemDeliveryJob.run());
  scheduler.registerInterval('gitlab-integration-sync', 60000, () => integrationsService.runDueGitLabSyncs());
  scheduler.registerInterval('github-integration-health', 60000, () => integrationsService.runDueGitHubHealthChecks());
  scheduler.registerInterval('ssh-integration-health', 60000, () => externalSshService.runDueHealthChecks());
  scheduler.registerInterval('cloudflare-integration-sync', 60000, () => integrationsService.runDueCloudflareSyncs());

  setTimeout(() => {
    licenseService.heartbeat().catch((error) => {
      logger.warn('Initial license heartbeat failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 1000);
  setTimeout(() => {
    housekeepingService
      .getConfig()
      .then((config) =>
        loggingMaintenanceService.runGuard(
          config.enabled ? config.structuredLogs : undefined,
          config.enabled ? config.clickHouseInternals : undefined
        )
      )
      .catch((error) => logger.warn('Initial ClickHouse health guard failed', { error }));
  }, 1000);

  // Read models warm asynchronously. Gateway readiness and request handlers
  // never wait for a node or external resource to answer this initial pass.
  readModelCoordinator.start();
}
