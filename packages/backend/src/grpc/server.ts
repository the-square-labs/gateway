import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { validateGrpcServerCertificate } from '@/services/grpc-server-certificate.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { SystemCAService } from '@/services/system-ca.service.js';
import {
  configureRelayForwardedIdentityTrust,
  isTrustedRelayServiceCall,
  stageRelayForwardedIdentityTrust,
} from './interceptors/auth.js';
import { createControlHandlers } from './services/control.js';
import { createDatabaseTunnelHandlers } from './services/database-tunnel.js';
import { createEnrollmentHandlers } from './services/enrollment.js';
import { createLogStreamHandlers } from './services/log-stream.js';
import { createMigrationTransferHandlers } from './services/migration-transfer.js';

const logger = createChildLogger('GrpcServer');
const GRPC_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

function resolveProtoPath() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'proto/gateway/v1/nginx-daemon.proto'),
    resolve(process.cwd(), '../proto/gateway/v1/nginx-daemon.proto'),
    resolve(process.cwd(), '../../proto/gateway/v1/nginx-daemon.proto'),
    resolve(moduleDir, '../../proto/gateway/v1/nginx-daemon.proto'),
    resolve(moduleDir, '../../../proto/gateway/v1/nginx-daemon.proto'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not locate nginx-daemon.proto. Tried: ${candidates.join(', ')}`);
}

const PROTO_PATH = resolveProtoPath();

type CaCertificateUpdate = { caCertificate: Buffer } | null;
type IdentityCertificateUpdate = { certificate: Buffer; privateKey: Buffer } | null;
type CaCertificateUpdateListener = (update: CaCertificateUpdate) => void;
type IdentityCertificateUpdateListener = (update: IdentityCertificateUpdate) => void;

class ReloadableCertificateProvider {
  private caListeners = new Set<CaCertificateUpdateListener>();
  private identityListeners = new Set<IdentityCertificateUpdateListener>();

  constructor(
    private caCertificate: Buffer,
    private certificate: Buffer,
    private privateKey: Buffer
  ) {}

  addCaCertificateListener(listener: CaCertificateUpdateListener) {
    this.caListeners.add(listener);
    setImmediate(() => listener({ caCertificate: this.caCertificate }));
  }

  removeCaCertificateListener(listener: CaCertificateUpdateListener) {
    this.caListeners.delete(listener);
  }

  addIdentityCertificateListener(listener: IdentityCertificateUpdateListener) {
    this.identityListeners.add(listener);
    setImmediate(() => listener({ certificate: this.certificate, privateKey: this.privateKey }));
  }

  removeIdentityCertificateListener(listener: IdentityCertificateUpdateListener) {
    this.identityListeners.delete(listener);
  }

  update(caCertificate: Buffer, certificate: Buffer, privateKey: Buffer) {
    this.caCertificate = caCertificate;
    this.certificate = certificate;
    this.privateKey = privateKey;
    for (const listener of this.caListeners) {
      listener({ caCertificate });
    }
    for (const listener of this.identityListeners) {
      listener({ certificate, privateKey });
    }
  }
}

export interface GrpcServerDeps {
  registry: NodeRegistryService;
  dispatch: NodeDispatchService;
  auditService: AuditService;
  db: DrizzleClient;
  caService: CAService;
  cryptoService: CryptoService;
  systemCA: SystemCAService;
  relayPeerFingerprint?: string;
}

let server: grpc.Server | null = null;
let certificateProvider: ReloadableCertificateProvider | null = null;

async function readGrpcServerTlsMaterial(
  tlsCertPath: string | undefined,
  tlsKeyPath: string | undefined,
  systemCA: SystemCAService
) {
  if (!tlsCertPath || !tlsKeyPath) {
    throw new Error('gRPC server requires TLS certificate and key paths');
  }

  const cert = readFileSync(tlsCertPath);
  const key = readFileSync(tlsKeyPath);
  const caPem = await systemCA.getSystemCACertPem();

  if (!caPem) {
    throw new Error('gRPC server requires the Gateway system CA certificate for daemon mTLS');
  }
  validateGrpcServerCertificate(cert, key, caPem);

  return { cert, key, ca: Buffer.from(caPem) };
}

export async function createGrpcServerCredentials(
  tlsCertPath: string | undefined,
  tlsKeyPath: string | undefined,
  systemCA: SystemCAService,
  requireClientCertificate = false
): Promise<grpc.ServerCredentials> {
  const { cert, key, ca } = await readGrpcServerTlsMaterial(tlsCertPath, tlsKeyPath, systemCA);

  // checkClientCertificate=false keeps enrollment open for new nodes, while
  // still requesting and validating client certs when enrolled daemons present them.
  certificateProvider = new ReloadableCertificateProvider(ca, cert, key);
  return (grpc.experimental as any).createCertificateProviderServerCredentials(
    certificateProvider,
    certificateProvider,
    requireClientCertificate
  );
}

export async function refreshGrpcServerCredentials(
  tlsCertPath: string | undefined,
  tlsKeyPath: string | undefined,
  systemCA: SystemCAService
): Promise<void> {
  if (!certificateProvider) {
    logger.debug('Skipping gRPC server TLS refresh because the server is not running');
    return;
  }

  const { cert, key, ca } = await readGrpcServerTlsMaterial(tlsCertPath, tlsKeyPath, systemCA);
  certificateProvider.update(ca, cert, key);
  logger.info('Refreshed gRPC server TLS material');
}

export function stageGrpcServerRelayTrust(nextFingerprint: string): () => void {
  return stageRelayForwardedIdentityTrust(nextFingerprint);
}

export async function startGrpcServer(
  port: number,
  tlsCertPath: string | undefined,
  tlsKeyPath: string | undefined,
  deps: GrpcServerDeps
): Promise<void> {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const gatewayV1 = proto.gateway.v1;
  const relayOnly = Boolean(deps.relayPeerFingerprint);
  configureRelayForwardedIdentityTrust(deps.relayPeerFingerprint ?? null);

  server = new grpc.Server({
    'grpc.keepalive_time_ms': 30000,
    'grpc.keepalive_timeout_ms': 10000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.max_send_message_length': GRPC_MAX_MESSAGE_BYTES,
    'grpc.max_receive_message_length': GRPC_MAX_MESSAGE_BYTES,
  });

  const protectUnary = (handler: (call: any, callback: any) => void) => (call: any, callback: any) => {
    if (!isTrustedRelayServiceCall(call)) {
      callback({ code: grpc.status.PERMISSION_DENIED, message: 'Current relay service identity required' });
      return;
    }
    handler(call, callback);
  };
  const protectStream = (handler: (call: any) => void) => (call: any) => {
    if (!isTrustedRelayServiceCall(call)) {
      call.destroy(
        Object.assign(new Error('Current relay service identity required'), { code: grpc.status.PERMISSION_DENIED })
      );
      return;
    }
    handler(call);
  };

  const enrollment = createEnrollmentHandlers(deps);
  const control = createControlHandlers(deps);
  const logs = createLogStreamHandlers(deps);
  const migration = createMigrationTransferHandlers(deps);
  server.addService(
    gatewayV1.NodeEnrollment.service,
    relayOnly
      ? {
          Enroll: protectUnary(enrollment.Enroll),
          RenewCertificate: protectUnary(enrollment.RenewCertificate),
        }
      : enrollment
  );
  server.addService(
    gatewayV1.NodeControl.service,
    relayOnly ? { CommandStream: protectStream(control.CommandStream) } : control
  );
  server.addService(gatewayV1.LogStream.service, relayOnly ? { StreamLogs: protectStream(logs.StreamLogs) } : logs);
  server.addService(
    gatewayV1.MigrationTransfer.service,
    relayOnly ? { Transfer: protectStream(migration.Transfer) } : migration
  );
  if (!relayOnly) server.addService(gatewayV1.DatabaseTunnel.service, createDatabaseTunnelHandlers(deps));

  const credentials = await createGrpcServerCredentials(tlsCertPath, tlsKeyPath, deps.systemCA, relayOnly);
  logger.info('gRPC server using TLS with Gateway system CA client certificate validation', { relayOnly });

  return new Promise((resolvePromise, reject) => {
    server!.bindAsync(`0.0.0.0:${port}`, credentials, (err, boundPort) => {
      if (err) {
        reject(err);
        return;
      }
      logger.info(`gRPC server listening on port ${boundPort}`);
      resolvePromise();
    });
  });
}

export function stopGrpcServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.tryShutdown(() => {
      logger.info('gRPC server stopped');
      server = null;
      certificateProvider = null;
      configureRelayForwardedIdentityTrust(null);
      resolve();
    });
  });
}
