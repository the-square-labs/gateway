import * as grpc from '@grpc/grpc-js';
import { createChildLogger } from '@/lib/logger.js';
import { AppGrpcProxy } from './app-proxy.js';
import { RelayAuthorizationRepository } from './authorization-repository.js';
import type { RelayConfig } from './config.js';
import { RelayControlService } from './control-service.js';
import { createStandaloneDatabaseTunnelHandlers } from './database-tunnel-service.js';
import { type RelayIdentitySnapshot, RelayIdentityStore } from './identity.js';
import { loadRelayProto } from './proto.js';
import { StandaloneDatabaseTunnelRelay } from './tunnel-relay.js';

const logger = createChildLogger('GatewayRelay');
const GRPC_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

type CaUpdate = { caCertificate: Buffer } | null;
type IdentityUpdate = { certificate: Buffer; privateKey: Buffer } | null;

class ReloadableCertificateProvider {
  private readonly caListeners = new Set<(update: CaUpdate) => void>();
  private readonly identityListeners = new Set<(update: IdentityUpdate) => void>();

  constructor(private snapshot: RelayIdentitySnapshot) {}

  addCaCertificateListener(listener: (update: CaUpdate) => void) {
    this.caListeners.add(listener);
    setImmediate(() => listener({ caCertificate: this.snapshot.systemCa }));
  }

  removeCaCertificateListener(listener: (update: CaUpdate) => void) {
    this.caListeners.delete(listener);
  }

  addIdentityCertificateListener(listener: (update: IdentityUpdate) => void) {
    this.identityListeners.add(listener);
    setImmediate(() =>
      listener({ certificate: this.snapshot.externalCertificate, privateKey: this.snapshot.externalPrivateKey })
    );
  }

  removeIdentityCertificateListener(listener: (update: IdentityUpdate) => void) {
    this.identityListeners.delete(listener);
  }

  update(snapshot: RelayIdentitySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.caListeners) listener({ caCertificate: snapshot.systemCa });
    for (const listener of this.identityListeners) {
      listener({ certificate: snapshot.externalCertificate, privateKey: snapshot.externalPrivateKey });
    }
  }
}

export interface StandaloneRelayRuntime {
  port: number;
  relay: StandaloneDatabaseTunnelRelay;
  stop(): Promise<void>;
  reloadIdentity(): Promise<boolean>;
}

export async function startStandaloneRelay(config: RelayConfig): Promise<StandaloneRelayRuntime> {
  const gatewayV1 = loadRelayProto();
  const identityStore = new RelayIdentityStore(config.identityDir);
  const initialIdentity = identityStore.load();
  const certificateProvider = new ReloadableCertificateProvider(initialIdentity);
  const authorization = RelayAuthorizationRepository.connect(config.databaseUrl);
  const relay = new StandaloneDatabaseTunnelRelay(authorization);
  const appProxy = new AppGrpcProxy(gatewayV1, config.appGrpcTarget, authorization, initialIdentity);
  const server = new grpc.Server({
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.max_send_message_length': GRPC_MAX_MESSAGE_BYTES,
    'grpc.max_receive_message_length': GRPC_MAX_MESSAGE_BYTES,
  });

  const reloadIdentity = async () => {
    const snapshot = identityStore.load();
    certificateProvider.update(snapshot);
    appProxy.replaceIdentity(snapshot);
    logger.info('Reloaded relay TLS and service trust material');
    return true;
  };
  const control = new RelayControlService({
    relayVersion: config.relayVersion,
    authorization,
    relay,
    appProxy,
    identity: () => identityStore.get(),
    reloadIdentity,
  });

  // This is deliberately an allowlist. A new daemon RPC is not proxied until
  // its identity and lifecycle behavior are explicitly classified.
  server.addService(gatewayV1.NodeEnrollment.service, appProxy.enrollmentHandlers());
  server.addService(gatewayV1.NodeControl.service, appProxy.controlHandlers());
  server.addService(gatewayV1.LogStream.service, appProxy.logHandlers());
  server.addService(gatewayV1.MigrationTransfer.service, appProxy.migrationHandlers());
  server.addService(
    gatewayV1.DatabaseTunnel.service,
    createStandaloneDatabaseTunnelHandlers(relay, authorization, (message) =>
      logger.warn('Database tunnel stream rejected', { message })
    )
  );
  server.addService(gatewayV1.GatewayRelayControl.service, control.handlers());

  const credentials = (grpc.experimental as any).createCertificateProviderServerCredentials(
    certificateProvider,
    certificateProvider,
    false
  ) as grpc.ServerCredentials;
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${config.port}`, credentials, (error, port) => (error ? reject(error) : resolve(port)));
  });
  logger.info('Standalone managed-database relay listening', { port: boundPort, relayVersion: config.relayVersion });

  const reconcileTimer = setInterval(() => {
    void relay.reconcileBindings().catch((error) =>
      logger.warn('Relay binding reconciliation deferred', {
        reason: (error as { reason?: string })?.reason ?? 'database_unavailable',
      })
    );
  }, config.reconcileIntervalMs);
  reconcileTimer.unref();
  const identityTimer = setInterval(() => {
    try {
      const snapshot = identityStore.reloadIfChanged();
      if (!snapshot) return;
      certificateProvider.update(snapshot);
      appProxy.replaceIdentity(snapshot);
      logger.info('Reloaded changed relay identity material');
    } catch {
      logger.error('Relay identity polling detected invalid material; keeping current in-memory identity');
    }
  }, config.identityPollIntervalMs);
  identityTimer.unref();

  let stopped = false;
  return {
    port: boundPort,
    relay,
    reloadIdentity,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(reconcileTimer);
      clearInterval(identityTimer);
      appProxy.close();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
      await authorization.close();
      logger.info('Standalone managed-database relay stopped');
    },
  };
}
