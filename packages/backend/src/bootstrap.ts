import 'reflect-metadata';
import { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import { createDrizzleClient } from '@/db/client.js';
import { RelayControlClient } from '@/grpc/relay-control.client.js';
import { refreshGrpcServerCredentials, stageGrpcServerRelayTrust } from '@/grpc/server.js';
import { logger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
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
import { AIPlanService } from '@/modules/ai/ai-plan.service.js';
import { AIProviderRuntimeService } from '@/modules/ai/ai-provider-runtime.service.js';
import { AIRunService } from '@/modules/ai/ai-run.service.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import { SiemDestinationService } from '@/modules/audit/siem-destination.service.js';
import { SiemAuditOutboxService } from '@/modules/audit/siem-outbox.service.js';
import { SiemTransportService } from '@/modules/audit/siem-transport.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthEmailQueueService } from '@/modules/auth/auth-email-queue.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { AvatarStorageService, resolveAvatarStorageDir } from '@/modules/auth/avatar-storage.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { PasskeyService } from '@/modules/auth/passkey.service.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseTunnelProxy } from '@/modules/databases/managed-database-tunnel-proxy.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerComposeNodeDispatcher } from '@/modules/docker/compose/compose-node-dispatcher.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerAccessResourceService } from '@/modules/docker/docker-access-resource.service.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import { DockerBuildRolloutService } from '@/modules/docker/docker-build-rollout.service.js';
import { DockerBuildRunnerService } from '@/modules/docker/docker-build-runner.service.js';
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
import {
  createDockerRegistryMaintenanceExecutor,
  DockerInternalRegistryService,
} from '@/modules/docker/docker-registry-internal.service.js';
import { DockerRegistryTokenService } from '@/modules/docker/docker-registry-token.service.js';
import { DockerRuntimeSettingsService } from '@/modules/docker/docker-runtime-settings.service.js';
import { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { DockerWebhookService } from '@/modules/docker/docker-webhook.service.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import { InferenceAccountingService } from '@/modules/inference/accounting/inference-accounting.service.js';
import { InferenceBudgetLockService } from '@/modules/inference/accounting/inference-budget-lock.service.js';
import { InferenceBudgetPolicyService } from '@/modules/inference/accounting/inference-budget-policy.js';
import { InferenceBudgetReservationService } from '@/modules/inference/accounting/inference-budget-reservation.service.js';
import { InferenceCoreAccountingService } from '@/modules/inference/accounting/inference-core-accounting.service.js';
import { InferenceReservationReconciler } from '@/modules/inference/accounting/inference-reservation-reconciler.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { InferenceCoreBridgeService } from '@/modules/inference/core/inference-core-bridge.service.js';
import { InferenceCoreExecutor } from '@/modules/inference/core/inference-core-executor.service.js';
import { InferenceCoreOperationService } from '@/modules/inference/core/inference-core-operation.service.js';
import { InferenceCoreProxyService } from '@/modules/inference/core/inference-core-proxy.service.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceCoreStore } from '@/modules/inference/core/inference-core-store.js';
import { InferenceCredentialVault } from '@/modules/inference/inference-credential-vault.js';
import { InferenceRuntimeService } from '@/modules/inference/inference-runtime.service.js';
import { InferenceSetupEventsService } from '@/modules/inference/inference-setup-events.service.js';
import { InferenceTokenService } from '@/modules/inference/inference-token.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import { InferenceModelAccessService } from '@/modules/inference/models/inference-model-access.service.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import { InferenceDestinationPolicy } from '@/modules/inference/providers/inference-destination-policy.js';
import { InferenceOAuthService } from '@/modules/inference/providers/inference-oauth.service.js';
import { InferenceProviderRegistry } from '@/modules/inference/providers/inference-provider.registry.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { InferenceProviderCredentialService } from '@/modules/inference/providers/inference-provider-credential.service.js';
import { InferenceRoutingService } from '@/modules/inference/providers/inference-routing.service.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { GitLabProvider } from '@/modules/integrations/gitlab-provider.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LicenseEntitlementReconcilerService } from '@/modules/license/license-entitlement-reconciler.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LicenseQuotaService } from '@/modules/license/license-quota.service.js';
import { LocalClickHouseService } from '@/modules/logging/local-clickhouse.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { LoggingIngestService } from '@/modules/logging/logging-ingest.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { LoggingMetadataService } from '@/modules/logging/logging-metadata.service.js';
import { LoggingRateLimitService } from '@/modules/logging/logging-rate-limit.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSchemaService } from '@/modules/logging/logging-schema.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import { LoggingSearchService } from '@/modules/logging/logging-search.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { LoggingTokenService } from '@/modules/logging/logging-token.service.js';
import { LoggingValidationService } from '@/modules/logging/logging-validation.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { DashboardReadModelService } from '@/modules/monitoring/dashboard-read-model.service.js';
import { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { NotificationAlertRuleService } from '@/modules/notifications/notification-alert-rule.service.js';
import { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import { NotificationDispatcherService } from '@/modules/notifications/notification-dispatcher.service.js';
import { NotificationWebhookService } from '@/modules/notifications/notification-webhook.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import { PageArtifactStore, resolvePageStorageDir } from '@/modules/pages/artifacts/page-artifact-store.js';
import { PageBuildRolloutService } from '@/modules/pages/deployments/page-build-rollout.service.js';
import { PageDeploymentService } from '@/modules/pages/deployments/page-deployment.service.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PageMaintenanceService } from '@/modules/pages/retention/page-maintenance.service.js';
import { PageRetentionService } from '@/modules/pages/retention/page-retention.service.js';
import { PageRouteService } from '@/modules/pages/routes/page-route.service.js';
import { PageNodeRuntimeService } from '@/modules/pages/runtime/page-node-runtime.service.js';
import { PageRuntimeConfigService } from '@/modules/pages/runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from '@/modules/pages/tags/page-publication.service.js';
import { PageTagService } from '@/modules/pages/tags/page-tag.service.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { CertService } from '@/modules/pki/cert.service.js';
import { CRLService } from '@/modules/pki/crl.service.js';
import { ExportService } from '@/modules/pki/export.service.js';
import { OCSPService } from '@/modules/pki/ocsp.service.js';
import { TemplatesService } from '@/modules/pki/templates.service.js';
import { AdditionalRouteService } from '@/modules/proxy/additional-route.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { ProxyDockerUpstreamService } from '@/modules/proxy/proxy-docker-upstream.service.js';
import { ProxyMaintenanceAccessService } from '@/modules/proxy/proxy-maintenance-access.service.js';
import { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import { EnvironmentSettingsService } from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { SetupWizardService } from '@/modules/setup/setup-wizard.service.js';
import { ACMEService } from '@/modules/ssl/acme.service.js';
import { resolveHttp01Ingress } from '@/modules/ssl/http01-ingress.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { UIBootstrapService } from '@/modules/ui-bootstrap/ui-bootstrap.service.js';
import { CacheService, createRedisClient } from '@/services/cache.service.js';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { DatabaseCAService } from '@/services/database-ca.service.js';
import { DockerService } from '@/services/docker.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { GatewayLifecycleService } from '@/services/gateway-lifecycle.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { NginxConfigGenerator } from '@/services/nginx-config-generator.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import { RelayDockerRecoveryService } from '@/services/relay-docker-recovery.service.js';
import { RelayIdentityProvisionerService } from '@/services/relay-identity-provisioner.service.js';
import { applyNewerInstalledRelayArtifact, loadInstalledRelayArtifact } from '@/services/relay-installed-artifact.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { RelayRegistryService } from '@/services/relay-registry.service.js';
import { RelayRegistryIngressService } from '@/services/relay-registry-ingress.service.js';
import { RelayStartupFinalizerService } from '@/services/relay-startup-finalizer.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import { RuntimeRestartService } from '@/services/runtime-restart.service.js';
import { SessionService } from '@/services/session.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import { UpdateService } from '@/services/update.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';

import { initializeBackgroundServices } from './bootstrap-background.js';

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
  const installedRelayArtifact = await loadInstalledRelayArtifact(db).catch((error) => {
    logger.warn('Failed to load persisted Relay artifact', { error });
    return null;
  });
  if (applyNewerInstalledRelayArtifact(env, installedRelayArtifact)) {
    logger.info('Restored newer managed Relay artifact from persisted update state', {
      buildVersion: installedRelayArtifact!.buildVersion,
    });
  }

  // Initialize and register Redis client
  logger.debug('Connecting to Redis...');
  const redis = createRedisClient(env.REDIS_URL);
  container.register(TOKENS.RedisClient, { useValue: redis });

  // Register services with explicit factories
  const cacheService = new CacheService(redis);
  container.registerInstance(CacheService, cacheService);

  const resourceSnapshotStore = new ResourceSnapshotStore(cacheService);
  container.registerInstance(ResourceSnapshotStore, resourceSnapshotStore);

  // Realtime event bus (in-process; swappable to Redis pub/sub later)
  const eventBus = new EventBusService();
  container.registerInstance(EventBusService, eventBus);
  const environmentSettingsService = new EnvironmentSettingsService(db, eventBus);
  await environmentSettingsService.initialize();
  container.registerInstance(EnvironmentSettingsService, environmentSettingsService);
  const readModelCoordinator = new ReadModelCoordinator(eventBus);
  container.registerInstance(ReadModelCoordinator, readModelCoordinator);
  const inferenceSetupEvents = new InferenceSetupEventsService(eventBus);
  container.registerInstance(InferenceSetupEventsService, inferenceSetupEvents);

  const sessionService = new SessionService(cacheService);
  container.registerInstance(SessionService, sessionService);
  container.registerInstance(RuntimeRestartService, new RuntimeRestartService());

  const cryptoService = new CryptoService(env.PKI_MASTER_KEY);
  container.registerInstance(CryptoService, cryptoService);

  const oidcSettingsService = new OidcSettingsService(db, cryptoService);
  container.registerInstance(OidcSettingsService, oidcSettingsService);

  const authSettingsService = new AuthSettingsService(db);
  container.registerInstance(AuthSettingsService, authSettingsService);
  const authEmailQueue = new AuthEmailQueueService(redis, cryptoService);
  const authMailService = new AuthMailService(db, cryptoService, authEmailQueue);
  authEmailQueue.start((delivery) => authMailService.deliverSecurityEmail(delivery.recipient, delivery.input));
  container.registerInstance(AuthEmailQueueService, authEmailQueue);
  container.registerInstance(AuthMailService, authMailService);

  const mcpSettingsService = new McpSettingsService(db);
  container.registerInstance(McpSettingsService, mcpSettingsService);

  const generalSettingsService = new GeneralSettingsService(db, inferenceSetupEvents, eventBus);
  container.registerInstance(GeneralSettingsService, generalSettingsService);
  await generalSettingsService.importLegacyPublicUrl(process.env.APP_URL);
  container.registerInstance(GatewayLifecycleService, new GatewayLifecycleService());

  // SIEM reuses the existing installation identifier only as a non-secret
  // source label. It does not participate in licensing or tier checks.
  const licenseService = new LicenseService(db, cryptoService, env, fetch, generalSettingsService, eventBus);
  container.registerInstance(LicenseService, licenseService);
  const licensePolicyService = new LicensePolicyService(licenseService);
  container.registerInstance(LicensePolicyService, licensePolicyService);
  generalSettingsService.setLicensePolicyService(licensePolicyService);
  const licenseQuotaService = new LicenseQuotaService(db, licensePolicyService);
  container.registerInstance(LicenseQuotaService, licenseQuotaService);
  const siemOutboxService = new SiemAuditOutboxService(licenseService, generalSettingsService);
  siemOutboxService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(SiemAuditOutboxService, siemOutboxService);

  const webTransportSettingsService = new WebTransportSettingsService(db, env.WEB_TLS_BOOTSTRAP_MODE);
  await webTransportSettingsService.initialize();
  container.registerInstance(WebTransportSettingsService, webTransportSettingsService);

  const networkSettingsService = new NetworkSettingsService(db);
  container.registerInstance(NetworkSettingsService, networkSettingsService);

  const outboundWebhookPolicyService = new OutboundWebhookPolicyService(db);
  container.registerInstance(OutboundWebhookPolicyService, outboundWebhookPolicyService);

  const auditService = new AuditService(db, siemOutboxService);
  auditService.setEventBus(eventBus);
  container.registerInstance(AuditService, auditService);

  const avatarStorageService = new AvatarStorageService(resolveAvatarStorageDir(env.NODE_ENV));
  await avatarStorageService.initialize();
  await avatarStorageService.migrateLegacyDataUrls(db);
  container.registerInstance(AvatarStorageService, avatarStorageService);

  const authService = new AuthService(
    db,
    sessionService,
    cacheService,
    authSettingsService,
    auditService,
    oidcSettingsService,
    generalSettingsService
  );
  authService.setLicenseQuotaService(licenseQuotaService);
  authService.setAvatarStorageService(avatarStorageService);
  container.registerInstance(AuthService, authService);
  container.registerInstance(
    LocalAuthService,
    new LocalAuthService(
      db,
      cacheService,
      sessionService,
      authSettingsService,
      container.resolve(AuthMailService),
      auditService,
      generalSettingsService
    )
  );
  const { DemoAuthService } = await import('@/modules/demo/demo-auth.service.js');
  container.registerInstance(
    DemoAuthService,
    new DemoAuthService(db, cacheService, container.resolve(AuthMailService))
  );
  container.registerInstance(MfaService, new MfaService(db, cacheService, cryptoService));
  container.registerInstance(
    PasskeyService,
    new PasskeyService(db, cacheService, authSettingsService, generalSettingsService)
  );
  const adminUserFolderService = new AdminUserFolderService(db, auditService);
  adminUserFolderService.setEventBus(eventBus);
  container.registerInstance(AdminUserFolderService, adminUserFolderService);

  const oauthService = new OAuthService(db, cacheService, auditService, authSettingsService, generalSettingsService);
  oauthService.setEventBus(eventBus);
  container.registerInstance(OAuthService, oauthService);

  const templatesService = new TemplatesService(db);
  container.registerInstance(TemplatesService, templatesService);

  const caService = new CAService(db, cryptoService, auditService);
  container.registerInstance(CAService, caService);

  const certService = new CertService(db, cryptoService, caService, auditService);
  container.registerInstance(CertService, certService);

  const crlService = new CRLService(db, caService, cacheService);
  container.registerInstance(CRLService, crlService);
  const systemCertificateLifecycleService = new SystemCertificateLifecycleService(db, certService, crlService);
  container.registerInstance(SystemCertificateLifecycleService, systemCertificateLifecycleService);

  const ocspService = new OCSPService(db, cryptoService, caService, cacheService);
  container.registerInstance(OCSPService, ocspService);

  const exportService = new ExportService(cryptoService);
  container.registerInstance(ExportService, exportService);

  const tokensService = new TokensService(db, auditService);
  tokensService.setEventBus(eventBus);
  container.registerInstance(TokensService, tokensService);

  const inferenceTokenService = new InferenceTokenService(db, auditService);
  inferenceTokenService.setEventBus(eventBus);
  container.registerInstance(InferenceTokenService, inferenceTokenService);
  const inferenceCredentialVault = new InferenceCredentialVault(cryptoService);
  container.registerInstance(InferenceCredentialVault, inferenceCredentialVault);
  const inferenceCoreStore = new InferenceCoreStore(db);
  container.registerInstance(InferenceCoreStore, inferenceCoreStore);
  const inferenceCoreBridgeService = new InferenceCoreBridgeService(inferenceCoreStore, inferenceCredentialVault);
  container.registerInstance(InferenceCoreBridgeService, inferenceCoreBridgeService);
  const inferenceProviderRegistry = new InferenceProviderRegistry();
  container.registerInstance(InferenceProviderRegistry, inferenceProviderRegistry);
  const inferenceDestinationPolicy = new InferenceDestinationPolicy();
  container.registerInstance(InferenceDestinationPolicy, inferenceDestinationPolicy);
  const inferenceOAuthService = new InferenceOAuthService(
    db,
    inferenceCredentialVault,
    inferenceProviderRegistry,
    fetch,
    inferenceCoreBridgeService
  );
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
    auditService,
    inferenceDestinationPolicy,
    inferenceCoreBridgeService,
    inferenceSetupEvents
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
    inferenceSetupEvents,
    inferenceCoreBridgeService
  );
  container.registerInstance(InferenceModelService, inferenceModelService);
  const inferenceModelConfigurationService = new InferenceModelConfigurationService(
    db,
    inferenceProviderRegistry,
    inferenceModelService,
    inferenceModelAccessService,
    auditService,
    inferenceSetupEvents
  );
  container.registerInstance(InferenceModelConfigurationService, inferenceModelConfigurationService);
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
  const inferenceCoreAccountingService = new InferenceCoreAccountingService(
    db,
    inferenceBudgetPolicyService,
    inferenceBudgetReservationService,
    inferenceBudgetLockService,
    eventBus
  );
  container.registerInstance(InferenceCoreAccountingService, inferenceCoreAccountingService);
  const inferenceCoreProxyService = new InferenceCoreProxyService(
    db,
    inferenceCoreBridgeService,
    inferenceModelService,
    inferenceRoutingService,
    inferenceCoreAccountingService,
    inferenceAccountingService
  );
  container.registerInstance(InferenceCoreProxyService, inferenceCoreProxyService);
  const inferenceCoreExecutor = new InferenceCoreExecutor(
    db,
    inferenceCoreProxyService,
    inferenceCoreAccountingService
  );
  container.registerInstance(InferenceCoreExecutor, inferenceCoreExecutor);
  inferenceRuntimeService.setExecutor(inferenceCoreExecutor);
  const inferenceUsageService = new InferenceUsageService(
    db,
    inferenceBudgetPolicyService,
    auditService,
    eventBus,
    inferenceModelAccessService
  );
  container.registerInstance(InferenceUsageService, inferenceUsageService);
  const inferenceReservationReconciler = new InferenceReservationReconciler(
    db,
    inferenceBudgetReservationService,
    inferenceBudgetLockService
  );
  container.registerInstance(InferenceReservationReconciler, inferenceReservationReconciler);
  inferenceReservationReconciler.start();

  const gitLabProvider = new GitLabProvider();
  const integrationsService = new IntegrationsService(db, auditService, cryptoService, [gitLabProvider]);
  integrationsService.setEventBus(eventBus);
  integrationsService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(IntegrationsService, integrationsService);
  const externalSshService = new ExternalSshService(db, cryptoService);
  externalSshService.setEventBus(eventBus);
  container.registerInstance(ExternalSshService, externalSshService);

  const alertService = new AlertService(db);
  container.registerInstance(AlertService, alertService);

  // Upsert built-in groups (creates on fresh install, syncs scopes on upgrade)
  {
    const { getBootstrapBuiltinGroups, canonicalizeScopes } = await import('@/lib/scopes.js');
    const { permissionGroups } = await import('@/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    for (const bg of getBootstrapBuiltinGroups(env.GATEWAY_DEPLOYMENT_MODE)) {
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
          set: { scopes: [...bg.scopes], description: bg.description, isBuiltin: true },
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
  systemCA.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(SystemCAService, systemCA);
  await systemCA.ensureSystemCA();

  const databaseCA = new DatabaseCAService(db, caService, certService);
  databaseCA.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(DatabaseCAService, databaseCA);
  await databaseCA.ensureDatabaseCA();
  const systemCertificateReconciliation = await systemCertificateLifecycleService.reconcileExistingSystemLeaves();
  if (systemCertificateReconciliation.adopted || systemCertificateReconciliation.unknown) {
    logger.info('Reconciled existing system certificate lifecycle records', systemCertificateReconciliation);
  }
  await systemCertificateLifecycleService.retryPendingCRLs();

  const grpcIdentityService = new GrpcIdentityService(env, systemCA);
  container.registerInstance(GrpcIdentityService, grpcIdentityService);
  await grpcIdentityService.resolve();

  const relayIdentityProvisioner = new RelayIdentityProvisionerService(
    db,
    certService,
    systemCertificateLifecycleService,
    systemCA,
    grpcIdentityService,
    env.GATEWAY_RELAY_IDENTITY_DIR
  );
  container.registerInstance(RelayIdentityProvisionerService, relayIdentityProvisioner);
  let relayControlClient: RelayControlClient | undefined;
  let relayPolicyService: RelayPolicyService | undefined;
  let appRelayClientFingerprint: string | undefined;
  if (env.GATEWAY_RELAY_REQUIRED) {
    const identity = await relayIdentityProvisioner.ensure();
    appRelayClientFingerprint = identity.appClientFingerprint;
    relayControlClient = new RelayControlClient({
      target: env.GATEWAY_RELAY_TARGET,
      systemCaPath: `${env.GATEWAY_RELAY_IDENTITY_DIR}/system-ca.crt`,
      certificatePath: identity.appClientCertPath,
      privateKeyPath: identity.appClientKeyPath,
    });
    container.registerInstance(RelayControlClient, relayControlClient);
    relayPolicyService = new RelayPolicyService(db, cryptoService, generalSettingsService, relayControlClient);
    container.registerInstance(RelayPolicyService, relayPolicyService);
    await relayPolicyService.ensureInitialized();
  }

  const webIdentityService = new WebIdentityService(env, systemCA);
  container.registerInstance(WebIdentityService, webIdentityService);

  // Nginx config generator (pure config generation, no I/O)
  const configValidator = new ConfigValidatorService();
  container.registerInstance(ConfigValidatorService, configValidator);

  const nginxConfigGenerator = new NginxConfigGenerator(configValidator);
  container.registerInstance(NginxConfigGenerator, nginxConfigGenerator);

  const folderService = new FolderService(db, auditService);
  container.registerInstance(FolderService, folderService);

  const nginxTemplateService = new NginxTemplateService(db, auditService, configValidator);
  container.registerInstance(NginxTemplateService, nginxTemplateService);

  // Node management (daemon communication)
  const nodeRegistry = new NodeRegistryService(db);
  container.registerInstance(NodeRegistryService, nodeRegistry);

  const nodeDispatch = new NodeDispatchService(nodeRegistry, db);
  container.registerInstance(NodeDispatchService, nodeDispatch);
  relayPolicyService?.setNodeDispatch(nodeDispatch);
  relayPolicyService?.setEventBus(eventBus);
  const relayPoolService = relayPolicyService
    ? new RelayPoolService(db, relayPolicyService, eventBus, auditService, generalSettingsService)
    : undefined;
  if (relayPoolService) container.registerInstance(RelayPoolService, relayPoolService);
  relayPoolService?.startReconciliation();

  const nginxCertificateDistribution = new NginxCertificateDistributionService(
    db,
    cryptoService,
    nginxConfigGenerator,
    nodeDispatch
  );
  nginxCertificateDistribution.setEventBus(eventBus);
  container.registerInstance(NginxCertificateDistributionService, nginxCertificateDistribution);

  const nodesService = new NodesService(db, auditService, nodeRegistry, grpcIdentityService, nodeDispatch);
  nodesService.setLicenseQuotaService(licenseQuotaService);
  nodesService.setGeneralSettingsService(generalSettingsService, env.GRPC_PORT);
  nodesService.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(NodesService, nodesService);

  const nodeFolderService = new NodeFolderService(db, auditService);
  container.registerInstance(NodeFolderService, nodeFolderService);

  const nodeMonitoringService = new NodeMonitoringService(nodeRegistry, cacheService);
  container.registerInstance(NodeMonitoringService, nodeMonitoringService);

  const dockerManagementService = new DockerManagementService(db, auditService, nodeDispatch, nodeRegistry);
  dockerManagementService.setLicensePolicyService(licensePolicyService);
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

  const dockerRegistryTokenService = new DockerRegistryTokenService();
  await dockerRegistryTokenService.initialize();
  container.registerInstance(DockerRegistryTokenService, dockerRegistryTokenService);
  const dockerInternalRegistryService = new DockerInternalRegistryService(db, dockerRegistryTokenService, auditService);
  dockerInternalRegistryService.setEventBus(eventBus);
  dockerInternalRegistryService.setLicensePolicyService(licensePolicyService);
  await dockerInternalRegistryService.initialize();
  await dockerInternalRegistryService.probeHealth().catch((error) => {
    logger.warn('Initial internal registry health probe failed', { error });
  });
  container.registerInstance(DockerInternalRegistryService, dockerInternalRegistryService);
  let relayRegistryService: RelayRegistryService | undefined;
  if (relayPolicyService) {
    relayRegistryService = new RelayRegistryService(
      db,
      relayPolicyService,
      nodeDispatch,
      dockerInternalRegistryService
    );
    relayRegistryService.setEventBus(eventBus);
    relayRegistryService.start();
    container.registerInstance(RelayRegistryService, relayRegistryService);
  }

  const dockerRegistryService = new DockerRegistryService(db, auditService, cryptoService, nodeDispatch);
  dockerRegistryService.setInternalRegistryService(dockerInternalRegistryService);
  container.registerInstance(DockerRegistryService, dockerRegistryService);
  dockerManagementService.setRegistryService(dockerRegistryService);
  integrationsService.setDockerRegistryService(dockerRegistryService);

  const dockerSecretService = new DockerSecretService(db, auditService, cryptoService);
  dockerSecretService.setEventBus(eventBus);
  dockerSecretService.setMigrationGuard(dockerMigrationGuard);
  container.registerInstance(DockerSecretService, dockerSecretService);

  const dockerEnvironmentService = new DockerEnvironmentService(db, cryptoService);
  dockerEnvironmentService.setMigrationGuard(dockerMigrationGuard);
  container.registerInstance(DockerEnvironmentService, dockerEnvironmentService);

  const dockerRuntimeSettingsService = new DockerRuntimeSettingsService(db);
  container.registerInstance(DockerRuntimeSettingsService, dockerRuntimeSettingsService);

  const dockerTaskService = new DockerTaskService(db);
  container.registerInstance(DockerTaskService, dockerTaskService);
  const dockerComposeService = new DockerComposeService(
    db,
    auditService,
    dockerTaskService,
    dockerSecretService,
    dockerSnapshotService
  );
  dockerComposeService.setDispatcher(new DockerComposeNodeDispatcher(nodeDispatch));
  dockerComposeService.setEventBus(eventBus);
  dockerComposeService.setSnapshotReconciler(dockerSnapshotReconciler);
  container.registerInstance(DockerComposeService, dockerComposeService);
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
  dockerDeploymentService.setLicensePolicyService(licensePolicyService);
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
  const dockerBuildService = new DockerBuildService(db);
  dockerBuildService.setEventBus(eventBus);
  if (relayRegistryService) {
    dockerBuildService.setBuildReleaseHandler((buildId) =>
      relayRegistryService.revokeContextBinding({ contextKind: 'build', contextId: buildId })
    );
  }
  container.registerInstance(DockerBuildService, dockerBuildService);
  const dockerBuildRunnerService = relayRegistryService
    ? new DockerBuildRunnerService(db, dockerBuildService, nodeDispatch, integrationsService, relayRegistryService)
    : null;
  if (dockerBuildRunnerService) container.registerInstance(DockerBuildRunnerService, dockerBuildRunnerService);
  dockerBuildService.setLicenseGuard(() => licensePolicyService.requireFeature('git-push-to-deploy'));
  dockerBuildService.setAdmissionGuard(async () => {
    await dockerInternalRegistryService.assertBuildAdmission();
    if (!dockerBuildRunnerService) {
      throw new AppError(503, 'BUILD_RUNNER_UNAVAILABLE', 'Build scheduling is unavailable');
    }
    await dockerBuildRunnerService.assertBuildAdmission();
  });
  const dockerBuildRolloutService = relayRegistryService
    ? new DockerBuildRolloutService(
        db,
        dockerManagementService,
        dockerDeploymentService,
        relayRegistryService,
        dockerComposeService
      )
    : null;
  if (dockerBuildRolloutService) {
    container.registerInstance(DockerBuildRolloutService, dockerBuildRolloutService);
    dockerBuildService.setArtifactRollout((buildId) => dockerBuildRolloutService.rollout(buildId));
  }
  const dockerSourceService = new DockerSourceService(db, auditService, integrationsService, cryptoService);
  dockerSourceService.setBuildService(dockerBuildService);
  dockerSourceService.setLicensePolicyService(licensePolicyService);
  dockerBuildRunnerService?.setSourceService(dockerSourceService);
  container.registerInstance(DockerSourceService, dockerSourceService);

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
  void dockerComposeService
    .recoverInterruptedOperations()
    .then(() => dockerBuildRolloutService?.recoverInterruptedComposeRollouts())
    .catch((error) => {
      logger.warn('Failed to recover interrupted Compose operations during bootstrap', { error });
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

  const managedDatabaseTunnelProxy = new ManagedDatabaseTunnelProxy(relayPolicyService, appRelayClientFingerprint);
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
  managedDatabaseService.setLicensePolicyService(licensePolicyService);
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
    try {
      await managedDatabaseService.reconcileBindingIdentities();
    } catch (error) {
      logger.warn('Failed to reconcile managed database identities during startup', { error });
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
    relayPolicyService,
    dockerComposeService,
    managedDatabaseService
  );
  managedDatabaseBindingService.setEventBus(eventBus);
  managedDatabaseBindingService.setLicensePolicyService(licensePolicyService);
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
  const proxySecureLinkService = relayPolicyService
    ? new ProxySecureLinkService(
        db,
        nodeDispatch,
        relayPolicyService,
        getEnv().SECURE_LINK_CONNECTOR_IMAGE,
        proxyDockerUpstreamService
      )
    : undefined;
  proxySecureLinkService?.setEventBus(eventBus);
  if (proxySecureLinkService) managedDatabaseBindingService.setTargetRuntimeReconciler(proxySecureLinkService);
  if (proxySecureLinkService) container.registerInstance(ProxySecureLinkService, proxySecureLinkService);
  const proxyMaintenanceAccessService = new ProxyMaintenanceAccessService(
    db,
    cacheService,
    auditService,
    cryptoService
  );
  container.registerInstance(ProxyMaintenanceAccessService, proxyMaintenanceAccessService);
  const proxyService = new ProxyService(
    db,
    nginxTemplateService,
    auditService,
    nginxConfigGenerator,
    nodeDispatch,
    nginxCertificateDistribution,
    proxyDockerUpstreamService,
    proxySecureLinkService,
    cacheService,
    proxyMaintenanceAccessService,
    generalSettingsService,
    relayPoolService
  );
  proxyService.setEventBus(eventBus);
  container.registerInstance(ProxyService, proxyService);
  dockerManagementService.setContainerRecreateCompletedHandler(async (nodeId, newContainerId) => {
    // A recreated workload keeps its persisted binding metadata, but the
    // daemon-owned listeners and Relay lanes still need to be proven against
    // the replacement container before the lifecycle task can report success.
    await managedDatabaseBindingService.reconcileBindingPrincipals(nodeId);
    await proxyService.reconcileDockerContainerRecreate(nodeId);
    await dockerSnapshotReconciler.finalizeContainerRecreate(nodeId, newContainerId);
  });
  if (relayPolicyService && relayRegistryService) {
    const relayRegistryIngressService = new RelayRegistryIngressService(
      relayPolicyService,
      nodeDispatch,
      dockerInternalRegistryService,
      proxyService
    );
    relayRegistryIngressService.setEventBus(eventBus);
    dockerInternalRegistryService.setExternalAccessReconciler((next, previous, userId) =>
      relayRegistryIngressService.reconcile(next, previous, userId)
    );
    relayRegistryIngressService.start();
    container.registerInstance(RelayRegistryIngressService, relayRegistryIngressService);
  }
  const additionalRouteService = new AdditionalRouteService(
    db,
    auditService,
    proxyDockerUpstreamService,
    proxySecureLinkService
  );
  additionalRouteService.setEventBus(eventBus);
  proxyService.setAdditionalRoutes(additionalRouteService);
  container.registerInstance(AdditionalRouteService, additionalRouteService);
  nodesService.setProxyService(proxyService);

  const dockerMigrationDispatch = new DockerMigrationDispatchAdapter(nodeDispatch);
  container.registerInstance(DockerMigrationDispatchAdapter, dockerMigrationDispatch);
  const dockerMigrationPreflight = new DockerMigrationPreflightService(
    db,
    dockerManagementService,
    dockerDeploymentService,
    dockerMigrationDispatch
  );
  container.registerInstance(DockerMigrationPreflightService, dockerMigrationPreflight);
  dockerMigrationPreflight.setLicensePolicyService(licensePolicyService);
  const dockerMigrationCoordinator = new DockerMigrationCoordinator(
    db,
    proxyService,
    dockerSnapshotReconciler,
    dockerAccessResourceService,
    relayRegistryService
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

  const statusPageService = new StatusPageService(db, proxyService, auditService, generalSettingsService);
  statusPageService.setEventBus(eventBus);
  statusPageService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(StatusPageService, statusPageService);

  const acmeService = new ACMEService();
  const http01ChallengeNodes = new Map<string, string>();
  acmeService.onHttp01Preflight = async (domains: string[]) => {
    await Promise.all(
      [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].map((domain) =>
        resolveHttp01Ingress(db, domain)
      )
    );
  };
  acmeService.onChallengeCreate = async (token: string, content: string, domain: string) => {
    const ingress = await resolveHttp01Ingress(db, domain);
    await nodeDispatch.deployAcmeChallenge(ingress.nodeId, token, content);
    http01ChallengeNodes.set(token, ingress.nodeId);
  };
  acmeService.onChallengeRemove = async (token: string, domain: string) => {
    const nodeId = http01ChallengeNodes.get(token) ?? (await resolveHttp01Ingress(db, domain)).nodeId;
    try {
      await nodeDispatch.removeAcmeChallenge(nodeId, token);
    } finally {
      http01ChallengeNodes.delete(token);
    }
  };
  container.registerInstance(ACMEService, acmeService);

  const accessListService = new AccessListService(
    db,
    nginxConfigGenerator,
    nginxTemplateService,
    auditService,
    nodeDispatch,
    nginxCertificateDistribution
  );
  accessListService.setEventBus(eventBus);
  container.registerInstance(AccessListService, accessListService);

  const sslService = new SSLService(db, acmeService, cryptoService, auditService, nginxCertificateDistribution);
  sslService.setEventBus(eventBus);
  sslService.setIntegrationsService(integrationsService);
  sslService.setProxyService(proxyService);
  integrationsService.setSSLService(sslService);
  container.registerInstance(SSLService, sslService);
  const sslCertificateFolderService = new SSLCertificateFolderService(db, auditService);
  sslCertificateFolderService.setEventBus(eventBus);
  container.registerInstance(SSLCertificateFolderService, sslCertificateFolderService);

  // Monitoring services
  const monitoringService = new MonitoringService(db);
  container.registerInstance(MonitoringService, monitoringService);
  const dashboardReadModels = new DashboardReadModelService(
    resourceSnapshotStore,
    readModelCoordinator,
    monitoringService,
    proxyService,
    databaseConnectionService,
    sslService,
    certService,
    caService
  );
  container.registerInstance(DashboardReadModelService, dashboardReadModels);

  // AI Settings
  const aiSettingsService = new AISettingsService(db, cryptoService);
  aiSettingsService.setInferenceFeatureResolver(() => generalSettingsService.isFeatureEnabled('inferenceEnabled'));
  aiSettingsService.setGatewayInferenceModelValidator(async (model) => {
    const models = await inferenceModelService.listAdmin();
    return models.some((candidate) => candidate.enabled && candidate.publicId === model);
  });
  inferenceModelService.setModelRemovedHandler((removedModel, replacementModel) =>
    aiSettingsService.handleGatewayInferenceModelRemoved(removedModel, replacementModel)
  );
  generalSettingsService.setInferenceDisabledHandler(() => aiSettingsService.handleInferenceDisabled());
  container.registerInstance(AISettingsService, aiSettingsService);
  const aiSandboxArtifactService = new AISandboxArtifactService(env);
  await aiSandboxArtifactService.cleanInterruptedFiles().catch((error) => {
    logger.warn('Failed to clean interrupted AI artifact writes during bootstrap', { error });
  });
  container.registerInstance(AISandboxArtifactService, aiSandboxArtifactService);
  const aiProviderRuntimeService = new AIProviderRuntimeService(
    aiSettingsService,
    generalSettingsService,
    inferenceModelService,
    inferenceRuntimeService,
    inferenceBudgetPolicyService,
    aiSandboxArtifactService
  );
  container.registerInstance(AIProviderRuntimeService, aiProviderRuntimeService);
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
  const aiPlanService = new AIPlanService(db);
  container.registerInstance(AIPlanService, aiPlanService);
  const aiRunService = new AIRunService(db, eventBus, aiConversationSearchService, aiPlanService);
  container.registerInstance(AIRunService, aiRunService);
  aiSandboxService.startPolicyReconciliation();
  authService.setSandboxService(aiSandboxService);

  // Domain management
  const domainsService = new DomainsService(db, auditService);
  domainsService.setEventBus(eventBus);
  domainsService.setIntegrationsService(integrationsService);
  domainsService.setNodeRegistryService(nodeRegistry);
  domainsService.setProxyService(proxyService);
  container.registerInstance(DomainsService, domainsService);
  domainsService.startIngressTargetReconciliation();
  domainsService.startCloudflareMigration();
  const domainFolderService = new DomainFolderService(db, auditService);
  domainFolderService.setEventBus(eventBus);
  container.registerInstance(DomainFolderService, domainFolderService);

  // Pages control plane
  const pageProjectService = new PageProjectService(db, auditService);
  pageProjectService.setEventBus(eventBus);
  container.registerInstance(PageProjectService, pageProjectService);
  const pageProjectFolderService = new PageProjectFolderService(db, auditService);
  pageProjectFolderService.setEventBus(eventBus);
  container.registerInstance(PageProjectFolderService, pageProjectFolderService);
  const pageArtifactStore = new PageArtifactStore(resolvePageStorageDir(env.PAGES_STORAGE_DIR, env.NODE_ENV));
  await pageArtifactStore.initialize();
  container.registerInstance(PageArtifactStore, pageArtifactStore);
  const pageDeployTokenService = new PageDeployTokenService(db, auditService);
  pageDeployTokenService.setEventBus(eventBus);
  container.registerInstance(PageDeployTokenService, pageDeployTokenService);
  const pageDeploymentService = new PageDeploymentService(db, auditService, generalSettingsService, pageArtifactStore);
  pageDeploymentService.setEventBus(eventBus);
  container.registerInstance(PageDeploymentService, pageDeploymentService);
  const pageTagService = new PageTagService(db, auditService);
  pageTagService.setEventBus(eventBus);
  container.registerInstance(PageTagService, pageTagService);
  const pageRuntimeConfigService = new PageRuntimeConfigService(db, auditService);
  pageRuntimeConfigService.setEventBus(eventBus);
  container.registerInstance(PageRuntimeConfigService, pageRuntimeConfigService);
  const pagePublicationService = new PagePublicationService(db, auditService, pageTagService);
  pagePublicationService.setEventBus(eventBus);
  container.registerInstance(PagePublicationService, pagePublicationService);
  const pageBuildRolloutService = new PageBuildRolloutService(
    db,
    dockerRegistryTokenService,
    pageDeploymentService,
    pagePublicationService
  );
  container.registerInstance(PageBuildRolloutService, pageBuildRolloutService);
  dockerBuildRolloutService?.setPagesRollout(pageBuildRolloutService);
  const pageRetentionService = new PageRetentionService(db, auditService, pageArtifactStore);
  pageRetentionService.setEventBus(eventBus);
  container.registerInstance(PageRetentionService, pageRetentionService);
  pageDeploymentService.setRetentionService(pageRetentionService);
  pageProjectService.setRetentionService(pageRetentionService);
  const pageMaintenanceService = new PageMaintenanceService(db, pageArtifactStore, pageRetentionService, eventBus);
  container.registerInstance(PageMaintenanceService, pageMaintenanceService);
  const pageProfileService = new PageProfileService(db, auditService, env.APP_URL);
  pageProfileService.setEventBus(eventBus);
  pageProfileService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(PageProfileService, pageProfileService);
  const pageNodeRuntimeService = new PageNodeRuntimeService(
    db,
    pageArtifactStore,
    nodeDispatch,
    nginxCertificateDistribution
  );
  container.registerInstance(PageNodeRuntimeService, pageNodeRuntimeService);
  pageProjectService.setRuntimeAdapter(pageNodeRuntimeService);
  pageProjectService.setRouteRuntimeAdapter(proxyService);
  pageMaintenanceService.setMigrationReconciler(pageProjectService);
  const pageRouteService = new PageRouteService(db, pageNodeRuntimeService, auditService, pageRuntimeConfigService);
  container.registerInstance(PageRouteService, pageRouteService);
  pageRouteService.setAdditionalRoutePublicationAdapter(additionalRouteService);
  pageProfileService.setRuntimeAdapter(pageNodeRuntimeService);
  pagePublicationService.setDeploymentAdapter(pageNodeRuntimeService);
  pagePublicationService.setAdapter(pageRouteService);
  pageRuntimeConfigService.setPublicationAdapter(pageRouteService);
  pageRetentionService.setRuntimeAdapter(pageNodeRuntimeService);
  proxyService.setPageRoutes(pageRouteService);
  additionalRouteService.setPageRuntime(pageNodeRuntimeService, pageRuntimeConfigService);
  domainsService.setPageProfileService(pageProfileService);

  // Browser-based first-run setup.
  const setupTokenPolicyService = new SetupTokenPolicyService(db, env.SETUP_BOOTSTRAP);
  await setupTokenPolicyService.ensureSetupStarted();
  container.registerInstance(SetupTokenPolicyService, setupTokenPolicyService);
  const setupAccessService = new SetupAccessService(db, cacheService, setupTokenPolicyService);
  container.registerInstance(SetupAccessService, setupAccessService);
  const finalizeSetupService = new FinalizeSetupService(db);
  container.registerInstance(FinalizeSetupService, finalizeSetupService);

  container.registerInstance(
    SetupWizardService,
    new SetupWizardService(
      db,
      setupTokenPolicyService,
      setupAccessService,
      generalSettingsService,
      authSettingsService,
      oidcSettingsService,
      authMailService,
      authService,
      container.resolve(LocalAuthService),
      finalizeSetupService,
      mcpSettingsService,
      async () => {
        const externalIdentity = await grpcIdentityService.refresh();
        if (!env.GATEWAY_RELAY_REQUIRED) {
          await refreshGrpcServerCredentials(externalIdentity.certPath, externalIdentity.keyPath, systemCA);
          return;
        }
        const relayIdentity = await relayIdentityProvisioner.refresh();
        const commitRelayTrust = stageGrpcServerRelayTrust(relayIdentity.relayClientFingerprint);
        await refreshGrpcServerCredentials(
          relayIdentity.internalServerCertPath,
          relayIdentity.internalServerKeyPath,
          systemCA
        );
        try {
          if (await relayControlClient?.reloadIdentity()) {
            managedDatabaseTunnelProxy.setAppCertificateFingerprint(relayIdentity.appClientFingerprint);
            commitRelayTrust();
          }
        } catch (error) {
          logger.warn('Relay identity refresh was not acknowledged; retaining both trusted relay identities', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      async () => {
        const transport = await webTransportSettingsService.getConfig();
        if (transport.tlsEnabled) await webIdentityService.refresh();
      }
    )
  );

  // Docker service (kept for self-update and image pruning only)
  const dockerService = new DockerService('/var/run/docker.sock', '');
  dockerInternalRegistryService.setExecutor(
    createDockerRegistryMaintenanceExecutor(dockerService, dockerRegistryTokenService)
  );
  await dockerInternalRegistryService.recoverInterruptedMaintenance().catch((error) => {
    logger.error('Failed to recover interrupted internal registry maintenance', { error });
  });
  container.registerInstance(DockerService, dockerService);
  container.resolve(ExternalSshService).setDockerService(dockerService);

  // Managed inference core lifecycle (OpenCodex container on this host).
  const inferenceCoreOperationService = new InferenceCoreOperationService(db);
  container.registerInstance(InferenceCoreOperationService, inferenceCoreOperationService);
  const inferenceCoreRuntimeService = new InferenceCoreRuntimeService(
    inferenceCoreStore,
    dockerService,
    env,
    container.resolve(InferenceCredentialVault),
    inferenceCoreOperationService,
    eventBus
  );
  container.registerInstance(InferenceCoreRuntimeService, inferenceCoreRuntimeService);
  // Reconcile with observed Docker state after a restart, then keep probing
  // health between steady states. Never blocks startup.
  void inferenceCoreRuntimeService.reconcileOnStartup().catch((error) => {
    console.error('[inference-core] startup reconciliation failed', error);
  });
  inferenceCoreRuntimeService.startHealthProbe();
  const relayDockerRecovery = new RelayDockerRecoveryService(dockerService, env);
  container.registerInstance(RelayDockerRecoveryService, relayDockerRecovery);
  const relayStartupFinalizer = new RelayStartupFinalizerService(relayControlClient ?? null, relayDockerRecovery, {
    required: env.GATEWAY_RELAY_REQUIRED,
    expectedVersion: env.GATEWAY_RELAY_BUILD_VERSION,
    expectedProtocolMajor: env.GATEWAY_RELAY_PROTOCOL_MAJOR,
  });
  container.registerInstance(RelayStartupFinalizerService, relayStartupFinalizer);
  const relaySupervisor = new RelaySupervisorService(
    db,
    cacheService,
    relayControlClient ?? null,
    env.GATEWAY_RELAY_REQUIRED ? relayDockerRecovery : null,
    generalSettingsService,
    eventBus,
    auditService,
    {
      required: env.GATEWAY_RELAY_REQUIRED,
      managed: env.GATEWAY_RELAY_MANAGED,
      expectedImage: env.GATEWAY_RELAY_IMAGE_REF ?? null,
      expectedService: env.GATEWAY_RELAY_SERVICE_NAME,
      expectedVersion: env.GATEWAY_RELAY_BUILD_VERSION,
      expectedProtocolMajor: env.GATEWAY_RELAY_PROTOCOL_MAJOR,
    }
  );
  container.registerInstance(RelaySupervisorService, relaySupervisor);

  // Update service
  const updateService = new UpdateService(
    db,
    dockerService,
    env,
    {
      setMaintenance: (enabled) => relaySupervisor.setMaintenance(enabled),
      setExpectedArtifact: (imageRef, buildVersion, protocolMajor) => {
        relayDockerRecovery.setExpectedImage(imageRef);
        relaySupervisor.setExpectedArtifact(imageRef, buildVersion, protocolMajor);
      },
      updateSecureLinkConnectorImage: (imageRef) =>
        proxySecureLinkService?.updateConnectorImage(imageRef) ?? Promise.resolve(),
      probeNow: () => relaySupervisor.probeNow(),
    },
    generalSettingsService
  );
  container.registerInstance(UpdateService, updateService);

  const loggingSettingsService = new LoggingSettingsService(db, cryptoService);
  container.registerInstance(LoggingSettingsService, loggingSettingsService);
  const loggingClickHouseService = new LoggingClickHouseService();
  container.registerInstance(LoggingClickHouseService, loggingClickHouseService);
  const loggingFeatureService = new LoggingFeatureService(loggingClickHouseService);
  container.registerInstance(LoggingFeatureService, loggingFeatureService);

  const uiBootstrapService = new UIBootstrapService(
    resourceSnapshotStore,
    readModelCoordinator,
    nodesService,
    generalSettingsService,
    loggingFeatureService,
    integrationsService,
    statusPageService,
    updateService,
    aiProviderRuntimeService,
    aiSettingsService,
    finalizeSetupService,
    licensePolicyService,
    pageProfileService
  );
  container.registerInstance(UIBootstrapService, uiBootstrapService);
  const localClickHouseService = new LocalClickHouseService(dockerService);
  container.registerInstance(LocalClickHouseService, localClickHouseService);
  const loggingRuntimeService = new LoggingRuntimeService(
    loggingSettingsService,
    localClickHouseService,
    loggingClickHouseService,
    loggingFeatureService
  );
  loggingRuntimeService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingRuntimeService, loggingRuntimeService);
  const licenseEntitlementReconciler = new LicenseEntitlementReconcilerService(
    licensePolicyService,
    generalSettingsService,
    loggingRuntimeService,
    eventBus
  );
  licenseEntitlementReconciler.setPageProfileService(pageProfileService);
  licenseEntitlementReconciler.setDockerInternalRegistryService(dockerInternalRegistryService);
  container.registerInstance(LicenseEntitlementReconcilerService, licenseEntitlementReconciler);
  const loggingMaintenanceService = new LoggingMaintenanceService(loggingClickHouseService, loggingFeatureService);
  loggingMaintenanceService.setEventBus(eventBus);
  container.registerInstance(LoggingMaintenanceService, loggingMaintenanceService);
  try {
    await loggingRuntimeService.initialize();
  } catch (error) {
    loggingFeatureService.markUnavailable(error instanceof Error ? error.message : 'ClickHouse initialization failed');
    logger.warn('External logging ClickHouse initialization failed', { error });
  }
  const loggingEnvironmentService = new LoggingEnvironmentService(db, auditService, loggingClickHouseService);
  loggingEnvironmentService.setEventBus(eventBus);
  loggingEnvironmentService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingEnvironmentService, loggingEnvironmentService);
  const loggingEnvironmentFolderService = new LoggingEnvironmentFolderService(db, auditService);
  loggingEnvironmentFolderService.setEventBus(eventBus);
  container.registerInstance(LoggingEnvironmentFolderService, loggingEnvironmentFolderService);
  const loggingTokenService = new LoggingTokenService(db, auditService);
  loggingTokenService.setEventBus(eventBus);
  loggingTokenService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingTokenService, loggingTokenService);
  const loggingSchemaService = new LoggingSchemaService(db, auditService);
  loggingSchemaService.setEventBus(eventBus);
  loggingSchemaService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingSchemaService, loggingSchemaService);
  const loggingSchemaFolderService = new LoggingSchemaFolderService(db, auditService);
  loggingSchemaFolderService.setEventBus(eventBus);
  container.registerInstance(LoggingSchemaFolderService, loggingSchemaFolderService);
  const loggingValidationService = new LoggingValidationService();
  container.registerInstance(LoggingValidationService, loggingValidationService);
  const loggingRateLimitService = new LoggingRateLimitService(redis);
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

  const daemonUpdateService = new DaemonUpdateService(db, env, generalSettingsService);
  daemonUpdateService.setEventBus(eventBus);
  daemonUpdateService.setNodeRegistry(nodeRegistry);
  container.registerInstance(DaemonUpdateService, daemonUpdateService);
  nodeDispatch.setDaemonUpdateService(daemonUpdateService);
  nodesService.setDaemonUpdateService(daemonUpdateService);
  if (relayPoolService) {
    updateService.setRelayPoolUpdateRuntime({
      drainInstance: (instanceId, userId, enabled) => relayPoolService.drainInstance(instanceId, userId, enabled),
      prepareWorkerUpdate: (version, arch) =>
        daemonUpdateService.prepareTrustedDaemonUpdate('relay-worker', `${version}-relay`, version, arch),
      dispatchWorkerUpdate: async (nodeId, artifact) => {
        const result = await nodeDispatch.sendRelayWorkerUpdate(
          nodeId,
          artifact.downloadUrl,
          artifact.payload.version,
          artifact.checksum,
          artifact.signedManifest
        );
        if (!result.success) throw new Error(result.error || result.detail || 'Relay worker update failed');
      },
      prepareSupervisorUpdate: (version, arch) =>
        daemonUpdateService.prepareTrustedDaemonUpdate('relay', `${version}-relay`, version, arch),
      dispatchSupervisorUpdate: async (nodeId, artifact) => {
        const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, artifact.payload.version);
        try {
          const command = await nodeDispatch.sendUpdateDaemonCommand(
            nodeId,
            artifact.downloadUrl,
            artifact.payload.version,
            artifact.checksum,
            artifact.signedManifest
          );
          daemonUpdateService.trackNodeUpdateCompletion(nodeId, operationId, command.result);
          await command.accepted;
        } catch (error) {
          await daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId);
          throw error;
        }
      },
    });
  }

  // Housekeeping service
  const housekeepingService = new HousekeepingService(db, dockerService, nodeDispatch, env);
  housekeepingService.setSandboxArtifactService(aiSandboxArtifactService);
  housekeepingService.setDockerManagementService(dockerManagementService);
  housekeepingService.setLoggingMaintenanceService(loggingMaintenanceService);
  housekeepingService.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  housekeepingService.setPagesMaintenanceService(pageMaintenanceService);
  housekeepingService.setInternalRegistryMaintenanceService(dockerInternalRegistryService);
  container.registerInstance(HousekeepingService, housekeepingService);

  // Group service (injectable — resolve from container)
  const groupService = container.resolve(GroupService);
  groupService.setEventBus(eventBus);
  groupService.setSandboxService(aiSandboxService);
  groupService.setLicenseQuotaService(licenseQuotaService);
  container.registerInstance(GroupService, groupService);
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
    outboundWebhookPolicyService,
    generalSettingsService
  );
  container.registerInstance(NotificationDispatcherService, notifDispatcherService);

  const siemTransportService = new SiemTransportService(
    env,
    cryptoService,
    outboundWebhookPolicyService,
    generalSettingsService
  );
  container.registerInstance(SiemTransportService, siemTransportService);
  const siemDeliveryService = new SiemDeliveryService(db, siemTransportService, generalSettingsService);
  siemDeliveryService.setEventBus(eventBus);
  siemDeliveryService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(SiemDeliveryService, siemDeliveryService);
  const siemDestinationService = new SiemDestinationService(db, auditService, cryptoService, siemTransportService);
  siemDestinationService.setEventBus(eventBus);
  siemDestinationService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(SiemDestinationService, siemDestinationService);

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
    aiProviderRuntimeService,
    siemDestinationService,
    siemDeliveryService,
    generalSettingsService,
    aiPlanService,
    dockerSnapshotService,
    licensePolicyService,
    eventBus
  );
  container.registerInstance(AIService, aiService);
  if (!container.isRegistered(AIService)) {
    throw new Error('AIService must be registered before interrupted AI runs are recovered');
  }
  await aiRunService.recoverInterruptedRuns((userId) => authService.getUserById(userId));

  await initializeBackgroundServices();

  logger.info('Dependency injection container initialized');
}
