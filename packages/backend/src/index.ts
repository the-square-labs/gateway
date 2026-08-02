// Must be first — set up environment and reflection metadata
import 'reflect-metadata';
import 'dotenv/config';

import { serve } from '@hono/node-server';

// Import services to ensure decorators are processed
import '@/services/cache.service.js';
import '@/services/session.service.js';
import '@/modules/auth/auth.service.js';

import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { createApp } from '@/app.js';
import { container, initializeContainer } from '@/bootstrap.js';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import { startGrpcServer, stopGrpcServer } from '@/grpc/server.js';
import { logger } from '@/lib/logger.js';
import { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import { AISandboxRunnerService } from '@/modules/ai/ai.sandbox-runner.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingMetadataService } from '@/modules/logging/logging-metadata.service.js';
import { ManagedDatabaseTunnelProxy } from '@/modules/databases/managed-database-tunnel-proxy.js';
import { CAService } from '@/modules/pki/ca.service.js';
import type { RedisClient } from '@/services/cache.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';

async function runMigrations(databaseUrl: string) {
  logger.info('Running database migrations...');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: resolve('src/db/migrations') });
  await pool.end();
  logger.info('Database migrations completed');
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

    // Create the Hono app
    const { app, injectWebSocket } = createApp();

    // Start the server
    const server = serve({
      fetch: app.fetch,
      port: env.PORT,
      hostname: env.BIND_HOST,
    });

    // Inject WebSocket support into the HTTP server
    injectWebSocket(server);

    logger.info(`Server running at http://${env.BIND_HOST}:${env.PORT}`);
    logger.info(`API Documentation at http://localhost:${env.PORT}/docs`);

    // Start gRPC server for daemon communication
    const registry = container.resolve(NodeRegistryService);
    const dispatch = container.resolve(NodeDispatchService);
    const auditService = container.resolve(AuditService);
    const caService = container.resolve(CAService);
    const cryptoService = container.resolve(CryptoService);
    const db = container.resolve(TOKENS.DrizzleClient) as any;
    const systemCA = container.resolve(SystemCAService);
    const grpcIdentity = await container.resolve(GrpcIdentityService).resolve();

    await startGrpcServer(env.GRPC_PORT, grpcIdentity.certPath, grpcIdentity.keyPath, {
      registry,
      dispatch,
      auditService,
      db,
      caService,
      cryptoService,
      systemCA,
    });

    // Start background jobs
    const sandboxRunner = container.resolve(AISandboxRunnerService);
    try {
      await sandboxRunner.health();
    } catch (err) {
      logger.warn('Sandbox runner is unavailable at startup', { err });
    }

    const scheduler = container.resolve(SchedulerService);
    scheduler.start();

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down server...');
      scheduler.stop();

      try {
        await stopGrpcServer();
      } catch (err) {
        logger.error('Failed to stop gRPC server', { err });
      }

      try {
        await container.resolve(ManagedDatabaseTunnelProxy).shutdown();
      } catch (err) {
        logger.error('Failed to close managed database tunnel listeners', { err });
      }

      try {
        const sandbox = container.resolve(AISandboxService);
        sandbox.stopPolicyReconciliation();
        await sandboxRunner.stop();
        logger.info('Sandbox runner stopped');
      } catch (err) {
        logger.error('Failed to stop sandbox runner', { err });
      }

      try {
        const metadata = container.resolve(LoggingMetadataService);
        await metadata.close();
        logger.info('Logging metadata queue flushed');
      } catch (err) {
        logger.error('Failed to flush logging metadata queue', { err });
      }

      try {
        const clickHouse = container.resolve(LoggingClickHouseService);
        await clickHouse.close();
        logger.info('ClickHouse connection closed');
      } catch (err) {
        logger.error('Failed to close ClickHouse', { err });
      }

      try {
        const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
        await redis.quit();
        logger.info('Redis connection closed');
      } catch (err) {
        logger.error('Failed to close Redis', { err });
      }

      try {
        const db = container.resolve(TOKENS.DrizzleClient) as any;
        await db.$client?.end?.();
        logger.info('Database pool closed');
      } catch (err) {
        logger.error('Failed to close database pool', { err });
      }

      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
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
