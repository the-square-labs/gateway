import 'reflect-metadata';
import { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import { createDrizzleClient } from '@/db/client.js';
import { ACMERenewalJob } from '@/jobs/acme-renewal.job.js';
import { DaemonUpdateCheckJob } from '@/jobs/daemon-update-check.job.js';
import { DnsCheckJob } from '@/jobs/dns-check.job.js';
import { ExpiryAlertJob } from '@/jobs/expiry-alert.job.js';
import { HealthCheckJob } from '@/jobs/health-check.job.js';
import { HousekeepingJob } from '@/jobs/housekeeping.job.js';
import { NotificationRetryJob } from '@/jobs/notification-retry.job.js';
import { UpdateCheckJob } from '@/jobs/update-check.job.js';
import { logger } from '@/lib/logger.js';
import { AccessListService } from '@/modules/access-lists/access-list.service.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import { AISandboxArtifactService } from '@/modules/ai/ai.sandbox-artifact.service.js';
import { AISandboxJobsService } from '@/modules/ai/ai.sandbox-jobs.service.js';
import { AISandboxRunnerService } from '@/modules/ai/ai.sandbox-runner.service.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { AISettingsService } from '@/modules/ai/ai.settings.service.js';
import { AIConversationService } from '@/modules/ai/ai-conversation.service.js';
import { AIConversationFolderService } from '@/modules/ai/ai-conversation-folder.service.js';
import { AIConversationSearchService } from '@/modules/ai/ai-conversation-search.service.js';
import { AIProviderRuntimeService } from '@/modules/ai/ai-provider-runtime.service.js';
import { AIRunService } from '@/modules/ai/ai-run.service.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthEmailQueueService } from '@/modules/auth/auth-email-queue.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { PasskeyService } from '@/modules/auth/passkey.service.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseTunnelProxy } from '@/modules/databases/managed-database-tunnel-proxy.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerAccessResourceService } from '@/modules/docker/docker-access-resource.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { DockerHealthCheckService } from '@/modules/docker/docker-health-check.service.js';
import { DockerImageCleanupService } from '@/modules/docker/docker-image-cleanup.service.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { DockerMigrationCoordinator } from '@/modules/docker/docker-migration-coordinator.js';
import { DockerMigrationDispatchAdapter } from '@/modules/docker/docker-migration-dispatch.js';
import { DockerMigrationExecutor } from '@/modules/docker/docker-migration-executor.js';
import { DockerMigrationGuard } from '@/modules/docker/docker-migration-guard.js';
import { DockerMigrationPreflightService } from '@/modules/docker/docker-migration-preflight.js';
import { DockerRegistryService } from '@/modules/docker/docker-registry.service.js';
import { DockerRuntimeSettingsService } from '@/modules/docker/docker-runtime-settings.service.js';
import { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { DockerWebhookService } from '@/modules/docker/docker-webhook.service.js';
import { detectPublicIP, initDnsResolver } from '@/modules/domains/dns.utils.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import { InferenceAccountingService } from '@/modules/inference/accounting/inference-accounting.service.js';
import { InferenceBudgetLockService } from '@/modules/inference/accounting/inference-budget-lock.service.js';
import { InferenceBudgetPolicyService } from '@/modules/inference/accounting/inference-budget-policy.js';
import { InferenceBudgetReservationService } from '@/modules/inference/accounting/inference-budget-reservation.service.js';
import { InferenceReservationReconciler } from '@/modules/inference/accounting/inference-reservation-reconciler.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { InferenceContinuationService } from '@/modules/inference/inference-continuation.service.js';
import { InferenceCredentialVault } from '@/modules/inference/inference-credential-vault.js';
import { InferenceExtendedService } from '@/modules/inference/inference-extended.service.js';
import { InferenceGatewayExecutor } from '@/modules/inference/inference-gateway.executor.js';
import { InferenceProtocolService } from '@/modules/inference/inference-protocol.service.js';
import { InferenceRuntimeService } from '@/modules/inference/inference-runtime.service.js';
import { InferenceSetupEventsService } from '@/modules/inference/inference-setup-events.service.js';
import { InferenceTokenService } from '@/modules/inference/inference-token.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import { InferenceModelAccessService } from '@/modules/inference/models/inference-model-access.service.js';
import { InferenceDestinationPolicy } from '@/modules/inference/providers/inference-destination-policy.js';
import { InferenceOAuthService } from '@/modules/inference/providers/inference-oauth.service.js';
import { InferenceProviderRegistry } from '@/modules/inference/providers/inference-provider.registry.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { InferenceProviderCredentialService } from '@/modules/inference/providers/inference-provider-credential.service.js';
import { InferenceProviderHttpConnector } from '@/modules/inference/providers/inference-provider-http.connector.js';
import { InferenceRoutingService } from '@/modules/inference/providers/inference-routing.service.js';
import { GitLabProvider } from '@/modules/integrations/gitlab-provider.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LICENSE_HEARTBEAT_INTERVAL_MS } from '@/modules/license/license.types.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { LoggingIngestService } from '@/modules/logging/logging-ingest.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { LoggingMetadataService } from '@/modules/logging/logging-metadata.service.js';
import { LoggingRateLimitService } from '@/modules/logging/logging-rate-limit.service.js';
import { LoggingSchemaService } from '@/modules/logging/logging-schema.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import { LoggingSearchService } from '@/modules/logging/logging-search.service.js';
import { LoggingTokenService } from '@/modules/logging/logging-token.service.js';
import { LoggingValidationService } from '@/modules/logging/logging-validation.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { NotificationAlertRuleService } from '@/modules/notifications/notification-alert-rule.service.js';
import { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import { NotificationDispatcherService } from '@/modules/notifications/notification-dispatcher.service.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { NotificationWebhookService } from '@/modules/notifications/notification-webhook.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { CertService } from '@/modules/pki/cert.service.js';
import { CRLService } from '@/modules/pki/crl.service.js';
import { ExportService } from '@/modules/pki/export.service.js';
import { OCSPService } from '@/modules/pki/ocsp.service.js';
import { TemplatesService } from '@/modules/pki/templates.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { ProxyDockerUpstreamService } from '@/modules/proxy/proxy-docker-upstream.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { SetupService } from '@/modules/setup/setup.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { ACMEService } from '@/modules/ssl/acme.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { StatusIncidentEvaluatorService } from '@/modules/status-page/status-incident-evaluator.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { CacheService, createRedisClient } from '@/services/cache.service.js';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { DatabaseCAService } from '@/services/database-ca.service.js';
import { DockerService } from '@/services/docker.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { NginxConfigGenerator } from '@/services/nginx-config-generator.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { SessionService } from '@/services/session.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { UpdateService } from '@/services/update.service.js';

export { container };

export async function initializeContainer(): Promise<void> {
  const env = getEnv();

  logger.info('Initializing dependency injection container...');

  // Register environment config
  container.register(TOKENS.Env, { useValue: env });

  // Initialize and register database client
  logger.debug('Connecting to database...');
  const db = createDrizzleClient(env.DATABASE_URL);
  container.register(TOKENS.DrizzleClient, { useValue: db });

  // Initialize and register Redis client
  logger.debug('Connecting to Redis...');
  const redis = createRedisClient(env.REDIS_URL);
  container.register(TOKENS.RedisClient, { useValue: redis });

  // Register services with explicit factories
  const cacheService = new CacheService(redis);
  container.registerInstance(CacheService, cacheService);

  // Realtime event bus (in-process; swappable to Redis pub/sub later)
  const eventBus = new EventBusService();
  container.registerInstance(EventBusService, eventBus);
  const inferenceSetupEvents = new InferenceSetupEventsService(eventBus);
  container.registerInstance(InferenceSetupEventsService, inferenceSetupEvents);

  const sessionService = new SessionService(cacheService);
  container.registerInstance(SessionService, sessionService);

  const cryptoService = new CryptoService(env.PKI_MASTER_KEY);
  container.registerInstance(CryptoService, cryptoService);

  const authSettingsService = new AuthSettingsService(db, cryptoService);
  container.registerInstance(AuthSettingsService, authSettingsService);
  const authEmailQueue = new AuthEmailQueueService(redis, cryptoService);
  const authMailService = new AuthMailService(db, cryptoService, authEmailQueue);
  authEmailQueue.start((delivery) => authMailService.deliverSecurityEmail(delivery.recipient, delivery.input));
  container.registerInstance(AuthEmailQueueService, authEmailQueue);
  container.registerInstance(AuthMailService, authMailService);

  const mcpSettingsService = new McpSettingsService(db);
  container.registerInstance(McpSettingsService, mcpSettingsService);

  const generalSettingsService = new GeneralSettingsService(db, inferenceSetupEvents);
  container.registerInstance(GeneralSettingsService, generalSettingsService);

  const networkSettingsService = new NetworkSettingsService(db);
  container.registerInstance(NetworkSettingsService, networkSettingsService);

  const outboundWebhookPolicyService = new OutboundWebhookPolicyService(db);
  container.registerInstance(OutboundWebhookPolicyService, outboundWebhookPolicyService);

  const auditService = new AuditService(db);
  container.registerInstance(AuditService, auditService);

  const authService = new AuthService(db, sessionService, cacheService, authSettingsService, auditService);
  container.registerInstance(AuthService, authService);
  container.registerInstance(
    LocalAuthService,
    new LocalAuthService(
      db,
      cacheService,
      sessionService,
      authSettingsService,
      container.resolve(AuthMailService),
      auditService
    )
  );
  container.registerInstance(MfaService, new MfaService(db, cacheService, cryptoService));
  container.registerInstance(PasskeyService, new PasskeyService(db, cacheService, authSettingsService));
  const adminUserFolderService = new AdminUserFolderService(db, auditService);
  adminUserFolderService.setEventBus(eventBus);
  container.registerInstance(AdminUserFolderService, adminUserFolderService);

  const oauthService = new OAuthService(db, cacheService, auditService, authSettingsService);
  container.registerInstance(OAuthService, oauthService);

  const templatesService = new TemplatesService(db);
  container.registerInstance(TemplatesService, templatesService);

  const caService = new CAService(db, cryptoService, auditService);
  container.registerInstance(CAService, caService);

  const certService = new CertService(db, cryptoService, caService, auditService);
  container.registerInstance(CertService, certService);

  const crlService = new CRLService(db, caService, cacheService);
  container.registerInstance(CRLService, crlService);

  const ocspService = new OCSPService(db, cryptoService, caService, cacheService);
  container.registerInstance(OCSPService, ocspService);

  const exportService = new ExportService(cryptoService);
  container.registerInstance(ExportService, exportService);

  const tokensService = new TokensService(db, auditService);
  container.registerInstance(TokensService, tokensService);

  const inferenceTokenService = new InferenceTokenService(db, auditService);
  container.registerInstance(InferenceTokenService, inferenceTokenService);
  const inferenceCredentialVault = new InferenceCredentialVault(cryptoService);
  container.registerInstance(InferenceCredentialVault, inferenceCredentialVault);
  const inferenceProviderRegistry = new InferenceProviderRegistry();
  container.registerInstance(InferenceProviderRegistry, inferenceProviderRegistry);
  const inferenceDestinationPolicy = new InferenceDestinationPolicy();
  container.registerInstance(InferenceDestinationPolicy, inferenceDestinationPolicy);
  const inferenceProviderConnector = new InferenceProviderHttpConnector(fetch, inferenceDestinationPolicy);
  container.registerInstance(InferenceProviderHttpConnector, inferenceProviderConnector);
  const inferenceOAuthService = new InferenceOAuthService(db, inferenceCredentialVault, inferenceProviderRegistry);
  container.registerInstance(InferenceOAuthService, inferenceOAuthService);
  const inferenceProviderCredentialService = new InferenceProviderCredentialService(
    db,
    redis,
    inferenceCredentialVault,
    inferenceOAuthService
  );
  container.registerInstance(InferenceProviderCredentialService, inferenceProviderCredentialService);
  const inferenceProviderService = new InferenceProviderService(
    db,
    inferenceProviderRegistry,
    inferenceProviderCredentialService,
    inferenceProviderConnector,
    auditService,
    inferenceDestinationPolicy
  );
  container.registerInstance(InferenceProviderService, inferenceProviderService);
  inferenceProviderService.start();
  const inferenceRoutingService = new InferenceRoutingService(db, redis);
  container.registerInstance(InferenceRoutingService, inferenceRoutingService);
  const inferenceBudgetPolicyService = new InferenceBudgetPolicyService(db);
  container.registerInstance(InferenceBudgetPolicyService, inferenceBudgetPolicyService);
  const inferenceModelAccessService = new InferenceModelAccessService(db, redis);
  container.registerInstance(InferenceModelAccessService, inferenceModelAccessService);
  const inferenceModelService = new InferenceModelService(
    db,
    inferenceProviderRegistry,
    inferenceModelAccessService,
    auditService,
    inferenceBudgetPolicyService,
    inferenceSetupEvents
  );
  container.registerInstance(InferenceModelService, inferenceModelService);
  const inferenceContinuationService = new InferenceContinuationService(redis, cryptoService);
  container.registerInstance(InferenceContinuationService, inferenceContinuationService);
  const inferenceRuntimeService = new InferenceRuntimeService();
  container.registerInstance(InferenceRuntimeService, inferenceRuntimeService);
  const inferenceBudgetReservationService = new InferenceBudgetReservationService(redis);
  container.registerInstance(InferenceBudgetReservationService, inferenceBudgetReservationService);
  const inferenceBudgetLockService = new InferenceBudgetLockService(db);
  container.registerInstance(InferenceBudgetLockService, inferenceBudgetLockService);
  const inferenceAccountingService = new InferenceAccountingService(
    inferenceBudgetPolicyService,
    inferenceBudgetReservationService,
    inferenceBudgetLockService,
    eventBus
  );
  container.registerInstance(InferenceAccountingService, inferenceAccountingService);
  const inferenceUsageService = new InferenceUsageService(db, inferenceBudgetPolicyService, auditService, eventBus);
  container.registerInstance(InferenceUsageService, inferenceUsageService);
  const inferenceReservationReconciler = new InferenceReservationReconciler(
    db,
    inferenceBudgetReservationService,
    inferenceBudgetLockService
  );
  container.registerInstance(InferenceReservationReconciler, inferenceReservationReconciler);
  inferenceReservationReconciler.start();
  const inferenceGatewayExecutor = new InferenceGatewayExecutor(
    db,
    inferenceModelService,
    inferenceRoutingService,
    inferenceAccountingService,
    inferenceProviderCredentialService,
    inferenceProviderRegistry,
    inferenceProviderConnector,
    inferenceDestinationPolicy
  );
  container.registerInstance(InferenceGatewayExecutor, inferenceGatewayExecutor);
  inferenceRuntimeService.setExecutor(inferenceGatewayExecutor);
  const inferenceExtendedService = new InferenceExtendedService(
    db,
    inferenceModelService,
    inferenceAccountingService,
    inferenceProviderCredentialService,
    inferenceProviderRegistry,
    inferenceProviderConnector,
    inferenceDestinationPolicy,
    inferenceRoutingService
  );
  container.registerInstance(InferenceExtendedService, inferenceExtendedService);
  const inferenceProtocolService = new InferenceProtocolService(
    inferenceRuntimeService,
    inferenceContinuationService,
    inferenceModelService
  );
  container.registerInstance(InferenceProtocolService, inferenceProtocolService);

  const gitLabProvider = new GitLabProvider();
  const integrationsService = new IntegrationsService(db, auditService, cryptoService, [gitLabProvider]);
  integrationsService.setEventBus(eventBus);
  container.registerInstance(IntegrationsService, integrationsService);

  const alertService = new AlertService(db);
  container.registerInstance(AlertService, alertService);

  // Upsert built-in groups (creates on fresh install, syncs scopes on upgrade)
  {
    const { BUILTIN_GROUPS, canonicalizeScopes } = await import('@/lib/scopes.js');
    const { permissionGroups } = await import('@/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    for (const bg of BUILTIN_GROUPS) {
      await db
        .insert(permissionGroups)
        .values({
          name: bg.name,
          description: bg.description,
          isBuiltin: true,
          scopes: [...bg.scopes],
        })
        .onConflictDoUpdate({
          target: permissionGroups.name,
          set: { scopes: [...bg.scopes], description: bg.description },
        });
    }

    const groups = await db.select().from(permissionGroups);
    for (const group of groups) {
      const originalScopes = Array.isArray(group.scopes) ? group.scopes : [];
      const canonicalScopes = canonicalizeScopes(originalScopes);
      const originalKey = [...originalScopes].sort().join('\0');
      const canonicalKey = [...canonicalScopes].sort().join('\0');
      if (originalKey === canonicalKey) continue;
      await db
        .update(permissionGroups)
        .set({ scopes: canonicalScopes, updatedAt: new Date() })
        .where(eq(permissionGroups.id, group.id));
      const removedScopes = originalScopes.filter((scope) => !canonicalScopes.includes(scope));
      logger.info('Sanitized permission group scopes', { groupId: group.id, groupName: group.name, removedScopes });
    }
  }

  // Ensure system user exists before system CA (it's the owner of bootstrap resources)
  {
    const { users } = await import('@/db/schema/index.js');
    const { permissionGroups } = await import('@/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const SYSTEM_OIDC = 'system:gateway-setup';
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.oidcSubject, SYSTEM_OIDC)).limit(1);
    if (existing.length === 0) {
      const adminGroup = await db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.name, 'system-admin'),
      });
      if (adminGroup) {
        await db.insert(users).values({
          id: '00000000-0000-0000-0000-000000000000',
          oidcSubject: SYSTEM_OIDC,
          email: 'system@gateway.local',
          name: 'Gateway System',
          groupId: adminGroup.id,
        });
        logger.info('Created system user');
      }
    }
  }

  // System CA for node mTLS
  const systemCA = new SystemCAService(db, caService, certService, cryptoService);
  systemCA.setGeneralSettingsService(generalSettingsService);
  container.registerInstance(SystemCAService, systemCA);
  await systemCA.ensureSystemCA();

  const databaseCA = new DatabaseCAService(db, caService, certService);
  container.registerInstance(DatabaseCAService, databaseCA);
  await databaseCA.ensureDatabaseCA();

  const grpcIdentityService = new GrpcIdentityService(env, systemCA);
  container.registerInstance(GrpcIdentityService, grpcIdentityService);
  await grpcIdentityService.resolve();

  // Nginx config generator (pure config generation, no I/O)
  const configValidator = new ConfigValidatorService();
  container.registerInstance(ConfigValidatorService, configValidator);

  const nginxConfigGenerator = new NginxConfigGenerator(configValidator);
  container.registerInstance(NginxConfigGenerator, nginxConfigGenerator);

  const folderService = new FolderService(db, auditService);
  container.registerInstance(FolderService, folderService);

  const nginxTemplateService = new NginxTemplateService(db, auditService);
  container.registerInstance(NginxTemplateService, nginxTemplateService);

  // Node management (daemon communication)
  const nodeRegistry = new NodeRegistryService(db);
  container.registerInstance(NodeRegistryService, nodeRegistry);

  const nodeDispatch = new NodeDispatchService(nodeRegistry, db);
  container.registerInstance(NodeDispatchService, nodeDispatch);

  const nodesService = new NodesService(db, auditService, nodeRegistry, grpcIdentityService, nodeDispatch);
  nodesService.setGeneralSettingsService(generalSettingsService, env.GRPC_PORT);
  container.registerInstance(NodesService, nodesService);

  const nodeFolderService = new NodeFolderService(db, auditService);
  container.registerInstance(NodeFolderService, nodeFolderService);

  const nodeMonitoringService = new NodeMonitoringService(nodeRegistry, cacheService);
  container.registerInstance(NodeMonitoringService, nodeMonitoringService);

  const dockerManagementService = new DockerManagementService(db, auditService, nodeDispatch, nodeRegistry);
  const dockerAccessResourceService = new DockerAccessResourceService(db);
  container.registerInstance(DockerAccessResourceService, dockerAccessResourceService);
  dockerManagementService.setAccessResourceService(dockerAccessResourceService);
  const dockerMigrationGuard = new DockerMigrationGuard(db);
  dockerManagementService.setMigrationGuard(dockerMigrationGuard);
  container.registerInstance(DockerManagementService, dockerManagementService);

  const dockerSnapshotService = new DockerSnapshotService(db, cacheService, nodeRegistry, eventBus);
  container.registerInstance(DockerSnapshotService, dockerSnapshotService);
  const dockerSnapshotReconciler = new DockerSnapshotReconciler(
    dockerSnapshotService,
    nodeDispatch,
    nodeRegistry,
    eventBus
  );
  container.registerInstance(DockerSnapshotReconciler, dockerSnapshotReconciler);
  dockerSnapshotReconciler.start();

  const dockerFolderService = new DockerFolderService(db, auditService);
  container.registerInstance(DockerFolderService, dockerFolderService);

  const dockerRegistryService = new DockerRegistryService(db, auditService, cryptoService, nodeDispatch);
  container.registerInstance(DockerRegistryService, dockerRegistryService);
  dockerManagementService.setRegistryService(dockerRegistryService);
  integrationsService.setDockerRegistryService(dockerRegistryService);

  const dockerSecretService = new DockerSecretService(db, auditService, cryptoService);
  dockerSecretService.setMigrationGuard(dockerMigrationGuard);
  container.registerInstance(DockerSecretService, dockerSecretService);

  const dockerEnvironmentService = new DockerEnvironmentService(db, cryptoService);
  dockerEnvironmentService.setMigrationGuard(dockerMigrationGuard);
  container.registerInstance(DockerEnvironmentService, dockerEnvironmentService);

  const dockerRuntimeSettingsService = new DockerRuntimeSettingsService(db);
  container.registerInstance(DockerRuntimeSettingsService, dockerRuntimeSettingsService);

  const dockerTaskService = new DockerTaskService(db);
  container.registerInstance(DockerTaskService, dockerTaskService);
  const dockerDeploymentService = new DockerDeploymentService(
    db,
    auditService,
    nodeDispatch,
    dockerRegistryService,
    dockerTaskService,
    nodeRegistry,
    dockerSecretService
  );
  container.registerInstance(DockerDeploymentService, dockerDeploymentService);
  dockerDeploymentService.setMigrationGuard(dockerMigrationGuard);
  dockerDeploymentService.setAccessResourceService(dockerAccessResourceService);
  const dockerHealthCheckService = new DockerHealthCheckService(db, nodeDispatch);
  container.registerInstance(DockerHealthCheckService, dockerHealthCheckService);
  const dockerImageCleanupService = new DockerImageCleanupService(db, dockerManagementService);
  container.registerInstance(DockerImageCleanupService, dockerImageCleanupService);
  dockerManagementService.setImageCleanupService(dockerImageCleanupService);
  dockerDeploymentService.setImageCleanupService(dockerImageCleanupService);
  const dockerWebhookService = new DockerWebhookService(
    db,
    dockerManagementService,
    dockerTaskService,
    auditService,
    nodeDispatch,
    dockerRegistryService,
    dockerImageCleanupService,
    dockerDeploymentService
  );
  container.registerInstance(DockerWebhookService, dockerWebhookService);

  dockerManagementService.setTaskService(dockerTaskService);
  dockerManagementService.setEnvironmentService(dockerEnvironmentService);
  dockerManagementService.setRuntimeSettingsService(dockerRuntimeSettingsService);
  dockerManagementService.setSecretService(dockerSecretService);
  dockerManagementService.setFolderService(dockerFolderService);
  dockerManagementService.setEventBus(eventBus);
  dockerManagementService.setDeploymentService(dockerDeploymentService);
  dockerFolderService.setEventBus(eventBus);
  dockerTaskService.setEventBus(eventBus);
  void dockerTaskService.markActiveTasksLostOnStartup().catch((error) => {
    logger.warn('Failed to mark interrupted Docker tasks during bootstrap', { error });
  });
  dockerDeploymentService.setEventBus(eventBus);
  dockerHealthCheckService.setEventBus(eventBus);
  dockerImageCleanupService.setEventBus(eventBus);
  dockerDeploymentService.setHealthCheckService(dockerHealthCheckService);
  dockerManagementService.setHealthCheckService(dockerHealthCheckService);
  dockerWebhookService.setEventBus(eventBus);
  authService.setEventBus(eventBus);
  templatesService.setEventBus(eventBus);
  caService.setEventBus(eventBus);
  certService.setEventBus(eventBus);
  nodesService.setEventBus(eventBus);
  nodeFolderService.setEventBus(eventBus);
  nodeRegistry.setEventBus(eventBus);
  folderService.setEventBus(eventBus);
  nginxTemplateService.setEventBus(eventBus);
  dockerRegistryService.setEventBus(eventBus);

  const managedDatabaseTunnelProxy = new ManagedDatabaseTunnelProxy();
  container.registerInstance(ManagedDatabaseTunnelProxy, managedDatabaseTunnelProxy);
  const databaseConnectionService = new DatabaseConnectionService(
    db,
    auditService,
    cryptoService,
    managedDatabaseTunnelProxy
  );
  container.registerInstance(DatabaseConnectionService, databaseConnectionService);

  const managedDatabaseService = new ManagedDatabaseService(
    db,
    auditService,
    cryptoService,
    nodeDispatch,
    databaseCA,
    databaseConnectionService
  );
  managedDatabaseService.setEventBus(eventBus);
  container.registerInstance(ManagedDatabaseService, managedDatabaseService);
  void (async () => {
    try {
      await managedDatabaseService.reconcileDatabaseConnections();
    } catch (error) {
      logger.warn('Failed to backfill managed database connection records', { error });
    }
    try {
      await managedDatabaseService.warmReadyPostgresExtensionCatalogs();
    } catch (error) {
      logger.warn('Failed to warm managed PostgreSQL extension catalogs', { error });
    }
  })();
  void managedDatabaseService.reconcileDatabaseCertificates().catch((error) => {
    logger.warn('Failed to backfill managed database TLS certificates', { error });
  });

  const managedDatabaseBindingService = new ManagedDatabaseBindingService(
    db,
    auditService,
    cryptoService,
    nodeDispatch,
    dockerManagementService,
    dockerDeploymentService,
    dockerSecretService,
    getEnv().DATABASE_CONNECTOR_IMAGE,
    getEnv().NODE_ENV === 'development'
  );
  managedDatabaseBindingService.setEventBus(eventBus);
  container.registerInstance(ManagedDatabaseBindingService, managedDatabaseBindingService);

  const databaseFolderService = new DatabaseFolderService(db, auditService);
  container.registerInstance(DatabaseFolderService, databaseFolderService);

  const databaseMonitoringService = new DatabaseMonitoringService(
    databaseConnectionService,
    cacheService,
    managedDatabaseService
  );
  container.registerInstance(DatabaseMonitoringService, databaseMonitoringService);
  databaseConnectionService.setEventBus(eventBus);
  databaseFolderService.setEventBus(eventBus);

  const proxyDockerUpstreamService = new ProxyDockerUpstreamService(
    db,
    dockerSnapshotService,
    nodeRegistry,
    dockerAccessResourceService
  );
  container.registerInstance(ProxyDockerUpstreamService, proxyDockerUpstreamService);
  const proxyService = new ProxyService(
    db,
    nginxTemplateService,
    auditService,
    cryptoService,
    nginxConfigGenerator,
    nodeDispatch,
    proxyDockerUpstreamService
  );
  proxyService.setEventBus(eventBus);
  container.registerInstance(ProxyService, proxyService);

  const dockerMigrationDispatch = new DockerMigrationDispatchAdapter(nodeDispatch);
  container.registerInstance(DockerMigrationDispatchAdapter, dockerMigrationDispatch);
  const dockerMigrationPreflight = new DockerMigrationPreflightService(
    db,
    dockerManagementService,
    dockerDeploymentService,
    dockerMigrationDispatch
  );
  container.registerInstance(DockerMigrationPreflightService, dockerMigrationPreflight);
  const dockerMigrationCoordinator = new DockerMigrationCoordinator(
    db,
    proxyService,
    dockerSnapshotReconciler,
    dockerAccessResourceService
  );
  container.registerInstance(DockerMigrationCoordinator, dockerMigrationCoordinator);
  const dockerMigrationExecutor = new DockerMigrationExecutor(
    db,
    dockerMigrationDispatch,
    dockerManagementService,
    dockerDeploymentService,
    dockerEnvironmentService,
    dockerSecretService,
    cryptoService
  );
  container.registerInstance(DockerMigrationExecutor, dockerMigrationExecutor);
  const dockerMigrationService = new DockerMigrationService(
    db,
    dockerMigrationPreflight,
    dockerMigrationExecutor,
    dockerMigrationCoordinator,
    auditService,
    eventBus,
    dockerManagementService
  );
  container.registerInstance(DockerMigrationService, dockerMigrationService);
  dockerMigrationService.start();

  const statusPageService = new StatusPageService(db, proxyService, auditService);
  statusPageService.setEventBus(eventBus);
  container.registerInstance(StatusPageService, statusPageService);

  const acmeService = new ACMEService(env.ACME_EMAIL, env.ACME_STAGING);
  // Wire ACME HTTP-01 challenge callbacks to deploy/remove via daemon.
  // Looks up which node(s) serve the requested domains, falling back to default node.
  const resolveNodeIdsForDomains = async (domains: string[]): Promise<string[]> => {
    const { sql, or } = await import('drizzle-orm');
    const { proxyHosts } = await import('@/db/schema/index.js');
    const conditions = domains.map((d) => sql`${proxyHosts.domainNames} @> ${JSON.stringify([d])}::jsonb`);
    const rows = await db
      .selectDistinct({ nodeId: proxyHosts.nodeId })
      .from(proxyHosts)
      .where(or(...conditions));
    const nodeIds = rows.map((r) => r.nodeId).filter(Boolean) as string[];
    if (nodeIds.length > 0) return [...new Set(nodeIds)];
    // Fallback: deploy to all online nginx nodes (handles initial setup before any proxy hosts exist)
    const { nodes: nodesTable } = await import('@/db/schema/index.js');
    const { and: andOp, eq: eqOp } = await import('drizzle-orm');
    const allNginx = await db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(andOp(eqOp(nodesTable.type, 'nginx'), eqOp(nodesTable.status, 'online')));
    return allNginx.map((n) => n.id);
  };

  acmeService.onChallengeCreate = async (token: string, content: string, domains: string[]) => {
    const nodeIds = await resolveNodeIdsForDomains(domains);
    if (nodeIds.length === 0) throw new Error('No nginx node found for ACME challenge deployment');
    for (const nid of nodeIds) {
      await nodeDispatch.deployAcmeChallenge(nid, token, content);
    }
  };
  acmeService.onChallengeRemove = async (token: string, domains: string[]) => {
    const nodeIds = await resolveNodeIdsForDomains(domains);
    for (const nid of nodeIds) {
      await nodeDispatch.removeAcmeChallenge(nid, token);
    }
  };
  container.registerInstance(ACMEService, acmeService);

  const accessListService = new AccessListService(
    db,
    nginxConfigGenerator,
    nginxTemplateService,
    auditService,
    nodeDispatch
  );
  accessListService.setEventBus(eventBus);
  container.registerInstance(AccessListService, accessListService);

  const sslService = new SSLService(db, acmeService, nginxConfigGenerator, cryptoService, auditService, nodeDispatch);
  sslService.setEventBus(eventBus);
  sslService.setIntegrationsService(integrationsService);
  integrationsService.setSSLService(sslService);
  container.registerInstance(SSLService, sslService);

  // Monitoring services
  const monitoringService = new MonitoringService(db);
  container.registerInstance(MonitoringService, monitoringService);

  // AI Settings
  const aiSettingsService = new AISettingsService(db, cryptoService);
  aiSettingsService.setInferenceFeatureResolver(() => generalSettingsService.isFeatureEnabled('inferenceEnabled'));
  aiSettingsService.setGatewayInferenceModelValidator(async (model) => {
    const models = await inferenceModelService.listAdmin();
    return models.some((candidate) => candidate.enabled && candidate.publicId === model);
  });
  generalSettingsService.setInferenceDisabledHandler(() => aiSettingsService.handleInferenceDisabled());
  container.registerInstance(AISettingsService, aiSettingsService);
  const aiProviderRuntimeService = new AIProviderRuntimeService(
    aiSettingsService,
    generalSettingsService,
    inferenceModelService,
    inferenceRuntimeService
  );
  container.registerInstance(AIProviderRuntimeService, aiProviderRuntimeService);
  const aiSandboxArtifactService = new AISandboxArtifactService(env);
  container.registerInstance(AISandboxArtifactService, aiSandboxArtifactService);
  const aiSandboxJobsService = new AISandboxJobsService(db);
  container.registerInstance(AISandboxJobsService, aiSandboxJobsService);
  const aiSandboxRunnerService = new AISandboxRunnerService();
  container.registerInstance(AISandboxRunnerService, aiSandboxRunnerService);
  const aiSandboxService = new AISandboxService(aiSandboxJobsService, aiSandboxRunnerService, aiSandboxArtifactService);
  container.registerInstance(AISandboxService, aiSandboxService);
  const aiConversationSearchService = new AIConversationSearchService(db, auditService);
  container.registerInstance(AIConversationSearchService, aiConversationSearchService);
  const aiConversationService = new AIConversationService(
    db,
    {
      artifacts: aiSandboxArtifactService,
      sandbox: aiSandboxService,
    },
    aiConversationSearchService
  );
  container.registerInstance(AIConversationService, aiConversationService);
  const aiConversationFolderService = new AIConversationFolderService(db, aiConversationSearchService);
  container.registerInstance(AIConversationFolderService, aiConversationFolderService);
  const aiRunService = new AIRunService(db, eventBus, aiConversationSearchService);
  container.registerInstance(AIRunService, aiRunService);
  aiSandboxService.startPolicyReconciliation();
  authService.setSandboxService(aiSandboxService);

  // Domain management
  const domainsService = new DomainsService(db, auditService);
  domainsService.setEventBus(eventBus);
  domainsService.setIntegrationsService(integrationsService);
  domainsService.setGeneralSettingsService(generalSettingsService);
  container.registerInstance(DomainsService, domainsService);
  const domainFolderService = new DomainFolderService(db, auditService);
  domainFolderService.setEventBus(eventBus);
  container.registerInstance(DomainFolderService, domainFolderService);

  // Setup service (bootstrap management SSL)
  const setupTokenPolicyService = new SetupTokenPolicyService(db, env.SETUP_BOOTSTRAP);
  await setupTokenPolicyService.ensureSetupStarted();
  container.registerInstance(SetupTokenPolicyService, setupTokenPolicyService);

  const setupService = new SetupService(db, sslService, proxyService, domainsService);
  container.registerInstance(SetupService, setupService);

  // Docker service (kept for self-update and image pruning only)
  const dockerService = new DockerService('/var/run/docker.sock', '');
  container.registerInstance(DockerService, dockerService);

  // Update service
  const updateService = new UpdateService(db, dockerService, env);
  container.registerInstance(UpdateService, updateService);

  const licenseService = new LicenseService(db, cryptoService, env);
  container.registerInstance(LicenseService, licenseService);

  const loggingFeatureService = new LoggingFeatureService(env);
  container.registerInstance(LoggingFeatureService, loggingFeatureService);
  const loggingClickHouseService = new LoggingClickHouseService(env);
  container.registerInstance(LoggingClickHouseService, loggingClickHouseService);
  const loggingMaintenanceService = new LoggingMaintenanceService(
    loggingClickHouseService,
    loggingFeatureService,
    env.CLICKHOUSE_MANAGED_INTERNAL_LOGS
  );
  container.registerInstance(LoggingMaintenanceService, loggingMaintenanceService);
  if (loggingClickHouseService.isConfigured()) {
    try {
      await loggingClickHouseService.ensureSchema();
      const available = await loggingClickHouseService.ping();
      if (available) {
        loggingFeatureService.markAvailable();
      } else {
        loggingFeatureService.markUnavailable('ClickHouse ping failed');
      }
    } catch (error) {
      loggingFeatureService.markUnavailable(
        error instanceof Error ? error.message : 'ClickHouse initialization failed'
      );
      logger.warn('External logging ClickHouse initialization failed', { error });
    }
  }
  const loggingEnvironmentService = new LoggingEnvironmentService(
    db,
    auditService,
    {
      requests: env.LOGGING_GLOBAL_REQUESTS_PER_WINDOW,
      events: env.LOGGING_GLOBAL_EVENTS_PER_WINDOW,
    },
    loggingClickHouseService
  );
  loggingEnvironmentService.setEventBus(eventBus);
  container.registerInstance(LoggingEnvironmentService, loggingEnvironmentService);
  const loggingEnvironmentFolderService = new LoggingEnvironmentFolderService(db, auditService);
  loggingEnvironmentFolderService.setEventBus(eventBus);
  container.registerInstance(LoggingEnvironmentFolderService, loggingEnvironmentFolderService);
  const loggingTokenService = new LoggingTokenService(db, auditService);
  container.registerInstance(LoggingTokenService, loggingTokenService);
  const loggingSchemaService = new LoggingSchemaService(db, auditService);
  loggingSchemaService.setEventBus(eventBus);
  container.registerInstance(LoggingSchemaService, loggingSchemaService);
  const loggingSchemaFolderService = new LoggingSchemaFolderService(db, auditService);
  loggingSchemaFolderService.setEventBus(eventBus);
  container.registerInstance(LoggingSchemaFolderService, loggingSchemaFolderService);
  const loggingValidationService = new LoggingValidationService(env);
  container.registerInstance(LoggingValidationService, loggingValidationService);
  const loggingRateLimitService = new LoggingRateLimitService(redis, env);
  container.registerInstance(LoggingRateLimitService, loggingRateLimitService);
  const loggingMetadataService = new LoggingMetadataService(db);
  container.registerInstance(LoggingMetadataService, loggingMetadataService);
  const loggingIngestService = new LoggingIngestService(
    loggingValidationService,
    loggingClickHouseService,
    loggingMetadataService
  );
  loggingIngestService.setEventBus(eventBus);
  container.registerInstance(LoggingIngestService, loggingIngestService);
  const loggingSearchService = new LoggingSearchService(loggingEnvironmentService, loggingClickHouseService);
  container.registerInstance(LoggingSearchService, loggingSearchService);

  const daemonUpdateService = new DaemonUpdateService(db, env);
  daemonUpdateService.setEventBus(eventBus);
  container.registerInstance(DaemonUpdateService, daemonUpdateService);
  nodeDispatch.setDaemonUpdateService(daemonUpdateService);
  nodesService.setDaemonUpdateService(daemonUpdateService);

  // Housekeeping service
  const housekeepingService = new HousekeepingService(db, dockerService, nodeDispatch, env);
  housekeepingService.setSandboxArtifactService(aiSandboxArtifactService);
  housekeepingService.setDockerManagementService(dockerManagementService);
  housekeepingService.setLoggingMaintenanceService(loggingMaintenanceService);
  container.registerInstance(HousekeepingService, housekeepingService);

  // Group service (injectable — resolve from container)
  const groupService = container.resolve(GroupService);
  groupService.setEventBus(eventBus);
  groupService.setSandboxService(aiSandboxService);
  groupService.setSessionService(sessionService);
  const permissionGroupFolderService = new PermissionGroupFolderService(db, auditService);
  permissionGroupFolderService.setEventBus(eventBus);
  container.registerInstance(PermissionGroupFolderService, permissionGroupFolderService);

  // ── Notification services (before AI — AI uses them) ──────────────
  const notifRuleService = new NotificationAlertRuleService(db, auditService);
  notifRuleService.setEventBus(eventBus);
  container.registerInstance(NotificationAlertRuleService, notifRuleService);

  const notifWebhookService = new NotificationWebhookService(db, auditService, cryptoService);
  notifWebhookService.setEventBus(eventBus);
  container.registerInstance(NotificationWebhookService, notifWebhookService);

  const notifDeliveryService = new NotificationDeliveryService(db);
  container.registerInstance(NotificationDeliveryService, notifDeliveryService);

  const notifDispatcherService = new NotificationDispatcherService(
    db,
    notifWebhookService,
    env,
    outboundWebhookPolicyService
  );
  container.registerInstance(NotificationDispatcherService, notifDispatcherService);

  // AI Service (depends on many services above)
  const aiService = new AIService(
    aiSettingsService,
    caService,
    certService,
    templatesService,
    proxyService,
    folderService,
    sslService,
    domainsService,
    accessListService,
    authService,
    auditService,
    monitoringService,
    nodesService,
    groupService,
    databaseConnectionService,
    dockerManagementService,
    notifRuleService,
    notifWebhookService,
    notifDeliveryService,
    notifDispatcherService,
    aiSandboxService,
    aiSandboxArtifactService,
    aiConversationSearchService,
    aiProviderRuntimeService
  );
  container.registerInstance(AIService, aiService);

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
  dockerManagementService.setEvaluator(notifEvaluatorService);
  dockerHealthCheckService.setEvaluator(notifEvaluatorService);
  databaseMonitoringService.setEvaluator(notifEvaluatorService);
  nodeRegistry.setEvaluator(notifEvaluatorService);
  proxyService.setEvaluator(notifEvaluatorService);
  notifEvaluatorService.start();
  container.registerInstance(NotificationEvaluatorService, notifEvaluatorService);

  housekeepingService.setNotifDeliveryService(notifDeliveryService);

  // Seed built-in templates
  await templatesService.seedBuiltinTemplates();
  await nginxTemplateService.seedBuiltinTemplates();

  // Background jobs
  const scheduler = new SchedulerService();
  container.registerInstance(SchedulerService, scheduler);

  const acmeRenewalJob = new ACMERenewalJob(db, sslService, alertService);
  acmeRenewalJob.setEventBus(eventBus);
  const healthCheckJob = new HealthCheckJob(db);
  healthCheckJob.setEventBus(eventBus);
  healthCheckJob.setEvaluator(notifEvaluatorService);
  const expiryAlertJob = new ExpiryAlertJob(db, alertService, env.EXPIRY_WARNING_DAYS, env.EXPIRY_CRITICAL_DAYS);
  expiryAlertJob.setEventBus(eventBus);

  const dnsCheckJob = new DnsCheckJob(domainsService);
  scheduler.registerInterval('dns-check', env.DNS_CHECK_INTERVAL_SECONDS * 1000, () => dnsCheckJob.run());

  scheduler.register('acme-renewal', env.ACME_RENEWAL_CRON, () => acmeRenewalJob.run());
  scheduler.registerInterval('health-check', env.HEALTH_CHECK_INTERVAL_SECONDS * 1000, () => healthCheckJob.run());
  scheduler.registerInterval('proxy-maintenance-alerts', env.HEALTH_CHECK_INTERVAL_SECONDS * 1000, () =>
    notifEvaluatorService.reconcileProxyMaintenance()
  );
  scheduler.registerInterval('docker-health-check', 10000, () => dockerHealthCheckService.runDueChecks());
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
  scheduler.register('expiry-alerts', env.EXPIRY_CHECK_CRON, async () => {
    await Promise.all([expiryAlertJob.run(), notifEvaluatorService.evaluateCertificateExpiry()]);
  });

  const updateCheckJob = new UpdateCheckJob(updateService);
  scheduler.registerInterval('update-check', env.UPDATE_CHECK_INTERVAL_HOURS * 3_600_000, () => updateCheckJob.run());
  scheduler.registerInterval('license-heartbeat', LICENSE_HEARTBEAT_INTERVAL_MS, () => licenseService.heartbeat());

  const daemonUpdateCheckJob = new DaemonUpdateCheckJob(daemonUpdateService);
  scheduler.registerInterval('daemon-update-check', env.UPDATE_CHECK_INTERVAL_HOURS * 3_600_000, () =>
    daemonUpdateCheckJob.run()
  );

  const housekeepingJob = new HousekeepingJob(housekeepingService);
  const hkConfig = await housekeepingService.getConfig();
  scheduler.register('housekeeping', hkConfig.cronExpression, () => housekeepingJob.run());
  scheduler.registerInterval('clickhouse-health-guard', 5 * 60 * 1000, async () => {
    const config = await housekeepingService.getConfig();
    await loggingMaintenanceService.runGuard(config.enabled ? config.structuredLogs : undefined);
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
  scheduler.registerInterval('gitlab-integration-sync', 60000, () => integrationsService.runDueGitLabSyncs());
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
      .then((config) => loggingMaintenanceService.runGuard(config.enabled ? config.structuredLogs : undefined))
      .catch((error) => logger.warn('Initial ClickHouse health guard failed', { error }));
  }, 1000);

  logger.info('Dependency injection container initialized');
}
