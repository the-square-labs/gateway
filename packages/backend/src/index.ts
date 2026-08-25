// Must be first — set up environment and reflection metadata
import 'reflect-metadata';
import 'dotenv/config';

import { serve } from '@hono/node-server';

// Import services to ensure decorators are processed
import '@/services/cache.service.js';
import '@/services/session.service.js';
import '@/modules/auth/auth.service.js';

import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { createApp } from '@/app.js';
import { container, initializeContainer } from '@/bootstrap.js';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import { RelayControlClient } from '@/grpc/relay-control.client.js';
import { startGrpcServer, stopGrpcServer } from '@/grpc/server.js';
import { closeApplicationLogger, logger } from '@/lib/logger.js';
import { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import { AISandboxRunnerService } from '@/modules/ai/ai.sandbox-runner.service.js';
import { AIRunService } from '@/modules/ai/ai-run.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthEmailQueueService } from '@/modules/auth/auth-email-queue.service.js';
import { ManagedDatabaseTunnelProxy } from '@/modules/databases/managed-database-tunnel-proxy.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { InferenceReservationReconciler } from '@/modules/inference/accounting/inference-reservation-reconciler.js';
import { inferenceCoreInternalRoutes } from '@/modules/inference/core/inference-core-internal.routes.js';
import { INFERENCE_CORE_INTERNAL_PORT } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingMetadataService } from '@/modules/logging/logging-metadata.service.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { RedisClient } from '@/services/cache.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { GatewayLifecycleService } from '@/services/gateway-lifecycle.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import { RelayIdentityProvisionerService } from '@/services/relay-identity-provisioner.service.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayStartupFinalizerService } from '@/services/relay-startup-finalizer.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { ShutdownCoordinator, waitForShutdownTasks } from '@/services/shutdown-coordinator.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import { drainWebSocketsForRestart, terminateRemainingWebSockets } from '@/services/websocket-shutdown.js';

async function runMigrations(databaseUrl: string) {
  logger.info('Running database migrations...');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: resolve('src/db/migrations') });
  await pool.end();
  logger.info('Database migrations completed');
}

type GatewayWebSocketServer = ReturnType<typeof createApp>['wss'];

function closeWebSocketServer(wss: GatewayWebSocketServer): Promise<void> {
  return new Promise((resolvePromise) => {
    wss.close(() => resolvePromise());
  });
}

function closeHttpServer(server: ReturnType<typeof serve>, deadline: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const connectionServer = server as typeof server & {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise();
    };
    server.close(finish);
    connectionServer.closeIdleConnections?.();
    if (settled) return;
    timer = setTimeout(
      () => {
        connectionServer.closeAllConnections?.();
        finish();
      },
      Math.max(0, deadline - Date.now())
    );
    timer.unref?.();
  });
}

function startInferenceCoreInternalServer(): Promise<ReturnType<typeof serve>> {
  return new Promise((resolvePromise, reject) => {
    const server = serve(
      {
        fetch: inferenceCoreInternalRoutes.fetch,
        port: INFERENCE_CORE_INTERNAL_PORT,
        hostname: '0.0.0.0',
      },
      () => {
        server.off('error', reject);
        resolvePromise(server);
      }
    );
    server.once('error', reject);
  });
}

async function main() {
  try {
    const env = getEnv();

    logger.info('Starting Gateway API...', {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
    });

    // Run database migrations before anything else
    await runMigrations(env.DATABASE_URL);

    // Initialize dependency injection container
    await initializeContainer();

    const statusPageService = container.resolve(StatusPageService);
    await statusPageService.primePublicHost();

    // Create the Hono app
    const { app, injectWebSocket, wss } = createApp();

    // Start exactly one web protocol on the public port. Native HTTPS uses a
    // dedicated leaf issued by the existing Gateway system CA.
    const webTransport = await container.resolve(WebTransportSettingsService).getConfig();
    const server = webTransport.tlsEnabled
      ? await (async () => {
          const identity = await container.resolve(WebIdentityService).resolve();
          return serve({
            fetch: app.fetch,
            port: env.PORT,
            hostname: env.BIND_HOST,
            createServer: createHttpsServer,
            serverOptions: {
              cert: await readFile(identity.certPath),
              key: await readFile(identity.keyPath),
            },
          });
        })()
      : serve({
          fetch: app.fetch,
          port: env.PORT,
          hostname: env.BIND_HOST,
        });

    // Inject WebSocket support into the HTTP server
    injectWebSocket(server);

    // Internal core → Gateway callback listener (admission/settlement). Bound
    // inside the container only; the port is never published to the host, so
    // just the installer-managed Compose network can reach it.
    const coreInternalServer = await startInferenceCoreInternalServer();
    logger.info(`Inference core internal listener on 0.0.0.0:${INFERENCE_CORE_INTERNAL_PORT}`);
    const lifecycle = container.resolve(GatewayLifecycleService);
    server.prependListener('request', (request, response) =>
      lifecycle.trackHttpRequest(request, response, statusPageService.isCachedStatusHost(request.headers.host))
    );

    const webScheme = webTransport.tlsEnabled ? 'https' : 'http';
    logger.info(`Server running at ${webScheme}://${env.BIND_HOST}:${env.PORT}`);
    logger.info(`API Documentation at ${webScheme}://localhost:${env.PORT}/docs`);

    // Start gRPC server for daemon communication
    const registry = container.resolve(NodeRegistryService);
    const dispatch = container.resolve(NodeDispatchService);
    const auditService = container.resolve(AuditService);
    const caService = container.resolve(CAService);
    const cryptoService = container.resolve(CryptoService);
    const db = container.resolve(TOKENS.DrizzleClient) as any;
    const systemCA = container.resolve(SystemCAService);
    const grpcIdentity = await container.resolve(GrpcIdentityService).resolve();
    const relayIdentity = env.GATEWAY_RELAY_REQUIRED
      ? await container.resolve(RelayIdentityProvisionerService).ensure()
      : null;
    const relayPolicy = env.GATEWAY_RELAY_REQUIRED ? container.resolve(RelayPolicyService) : undefined;

    await startGrpcServer(
      env.GRPC_PORT,
      relayIdentity?.internalServerCertPath ?? grpcIdentity.certPath,
      relayIdentity?.internalServerKeyPath ?? grpcIdentity.keyPath,
      {
        registry,
        dispatch,
        auditService,
        db,
        caService,
        cryptoService,
        systemCA,
        relayPeerFingerprint: relayIdentity?.relayClientFingerprint,
        relayPolicy,
      }
    );
    const relayFinalization = await container.resolve(RelayStartupFinalizerService).finalize();
    if (relayFinalization.status === 'degraded') {
      logger.error('Gateway relay startup finalization did not reach readiness', relayFinalization);
    } else if (relayFinalization.status === 'active') {
      logger.info('Gateway relay startup finalization completed', relayFinalization);
    }
    await container.resolve(RelaySupervisorService).start();

    // Start background jobs
    const sandboxRunner = container.resolve(AISandboxRunnerService);
    try {
      await sandboxRunner.health();
    } catch (err) {
      logger.warn('Sandbox runner is unavailable at startup', { err });
    }

    const scheduler = container.resolve(SchedulerService);
    scheduler.start();

    let userDrainPromises: Promise<unknown>[] = [];
    let loggingClosePromise: Promise<void> | null = null;
    let forceUserPromise: Promise<void> | null = null;
    const settleShutdownTask = async (name: string, task: Promise<unknown>): Promise<void> => {
      try {
        await task;
      } catch (error) {
        logger.warn('Shutdown task failed', { name, error });
      }
    };
    const shutdown = new ShutdownCoordinator({
      lifecycle,
      getSettings: () => container.resolve(GeneralSettingsService).getCachedShutdownSettings(),
      hooks: {
        freezeStatusPage: () => statusPageService.freezePublicSnapshot(),
        quiesce: async () => {
          userDrainPromises = [
            container.resolve(AISandboxService).stopPolicyReconciliation(),
            scheduler.stop(),
            container.resolve(RelaySupervisorService).stop(),
            container.resolve(NotificationEvaluatorService).stop(),
            container.resolve(InferenceProviderService).stop(),
            container.resolve(InferenceReservationReconciler).stop(),
            container.resolve(DockerSnapshotReconciler).stop(),
            container.resolve(DockerMigrationService).stop(),
            container.resolve(ReadModelCoordinator).stop(),
          ];
        },
        drainUserWork: async (deadline) => {
          await Promise.allSettled([...userDrainPromises, container.resolve(AIRunService).waitForIdle(deadline)]);
        },
        forceCloseUserWork: async () => {
          forceUserPromise ??= container.resolve(AIRunService).stopAllForShutdown();
          await forceUserPromise;
        },
        closeLogging: async () => {
          loggingClosePromise ??= (async () => {
            await settleShutdownTask('logging_metadata', container.resolve(LoggingMetadataService).close());
            logger.info('Logging metadata queue close completed');
            await settleShutdownTask('clickhouse', container.resolve(LoggingClickHouseService).close());
            logger.info('ClickHouse close completed');
          })();
          await loggingClosePromise;
        },
        closeHttp: async (deadline) => {
          // Keep established sessions alive through the expensive drain phases.
          // Signal restart only at the final transport shutdown boundary.
          await drainWebSocketsForRestart(wss.clients, deadline);
          terminateRemainingWebSockets(wss.clients);
          await closeWebSocketServer(wss);
          await closeHttpServer(server, deadline);
          if (coreInternalServer) await closeHttpServer(coreInternalServer, deadline);
          logger.info('HTTP server closed');
        },
        finalize: async (deadline) => {
          const independentFinalizers = [
            settleShutdownTask('managed_database_tunnel', container.resolve(ManagedDatabaseTunnelProxy).shutdown()),
            settleShutdownTask('auth_email_queue', container.resolve(AuthEmailQueueService).close()),
            settleShutdownTask(
              'relay_control_client',
              Promise.resolve().then(() => {
                if (env.GATEWAY_RELAY_REQUIRED) container.resolve(RelayControlClient).close();
              })
            ),
          ];
          const drainsSettled = await waitForShutdownTasks(
            [
              ...userDrainPromises,
              ...(forceUserPromise ? [forceUserPromise] : []),
              ...(loggingClosePromise ? [loggingClosePromise] : []),
            ],
            deadline
          );
          if (!drainsSettled) {
            throw new Error('Active shutdown work did not release its dependencies before the hard deadline');
          }

          await Promise.all([
            ...independentFinalizers,
            settleShutdownTask('grpc', stopGrpcServer(Math.min(3000, Math.max(0, deadline - Date.now())))),
            settleShutdownTask(
              'sandbox_runner',
              sandboxRunner.stop(Math.min(5_000, Math.max(0, deadline - Date.now() - 250)))
            ),
          ]);
          const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
          await settleShutdownTask('redis', redis.quit());
          logger.info('Redis close completed');
          const database = container.resolve(TOKENS.DrizzleClient) as any;
          await settleShutdownTask('postgres', Promise.resolve(database.$client?.end?.()));
          logger.info('Database pool close completed');
        },
        closeApplicationLogger: (deadline) => closeApplicationLogger(Math.max(0, deadline - Date.now())),
      },
      exit: (code) => process.exit(code),
    });

    process.on('SIGTERM', (signal) => void shutdown.request(signal));
    process.on('SIGINT', (signal) => void shutdown.request(signal));
  } catch (error) {
    logger.error('Failed to start server', {
      error,
      message: (error as Error)?.message,
      stack: (error as Error)?.stack,
    });
    process.exit(1);
  }
}

main();
