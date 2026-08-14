import { createHash, generateKeyPairSync } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { eq } from 'drizzle-orm';
import { Client } from 'ssh2';
import type { DrizzleClient } from '@/db/client.js';
import { externalSshConnectors, nodes } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DockerService } from '@/services/docker.service.js';
import type { User } from '@/types.js';

type Connector = typeof externalSshConnectors.$inferSelect;

export interface ExternalSshConnectorInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: 'password' | 'private_key';
  secret?: string;
  passphrase?: string;
  hostFingerprint: string;
  jumpConnectorId?: string | null;
  enabled?: boolean;
  generatePrivateKey?: boolean;
}

export class ExternalSshService {
  private dockerService: DockerService | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly crypto: CryptoService
  ) {}

  setDockerService(service: DockerService) {
    this.dockerService = service;
  }

  async list(user: User) {
    this.assertScope(user, 'integrations:ssh:view');
    const rows = await this.db.select().from(externalSshConnectors).orderBy(externalSshConnectors.name);
    return rows.map((row) => this.safe(row));
  }

  async create(user: User, input: ExternalSshConnectorInput) {
    this.assertScope(user, 'integrations:ssh:manage');
    await this.assertExternalTarget(input.host);
    if (!input.hostFingerprint.trim())
      throw new AppError(400, 'SSH_FINGERPRINT_REQUIRED', 'Approve the SSH host fingerprint first');
    let secret = input.secret?.trim() ?? '';
    let generatedPublicKey: string | null = null;
    if (input.generatePrivateKey) {
      const pair = generateKeyPairSync('ed25519');
      secret = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      generatedPublicKey = toOpenSshEd25519PublicKey(pair.publicKey.export({ format: 'jwk' }));
    }
    if (!secret) throw new AppError(400, 'SSH_SECRET_REQUIRED', 'A password or private key is required');
    const [created] = await this.db
      .insert(externalSshConnectors)
      .values({
        name: input.name.trim(),
        host: input.host.trim(),
        port: input.port ?? 22,
        username: input.username.trim(),
        authMethod: input.authMethod,
        encryptedSecret: JSON.stringify(this.crypto.encryptString(secret)),
        encryptedPassphrase: input.passphrase?.trim()
          ? JSON.stringify(this.crypto.encryptString(input.passphrase.trim()))
          : null,
        hostFingerprint: input.hostFingerprint.trim(),
        jumpConnectorId: input.jumpConnectorId ?? null,
        enabled: input.enabled ?? true,
        createdBy: user.id,
      })
      .returning();
    return { connector: this.safe(created), generatedPublicKey };
  }

  async execute(user: User, connectorId: string, command: string) {
    this.assertScope(user, 'integrations:ssh:use');
    const connector = await this.get(connectorId);
    if (!connector.enabled) throw new AppError(409, 'SSH_CONNECTOR_DISABLED', 'SSH connector is disabled');
    const targetAddress = await this.assertExternalTarget(connector.host);
    const output = await this.execConnector(connector, targetAddress, command);
    return { connectorId: connector.id, command, ...output };
  }

  private async get(id: string): Promise<Connector> {
    const [connector] = await this.db
      .select()
      .from(externalSshConnectors)
      .where(eq(externalSshConnectors.id, id))
      .limit(1);
    if (!connector) throw new AppError(404, 'SSH_CONNECTOR_NOT_FOUND', 'SSH connector not found');
    return connector;
  }

  private safe(row: Connector) {
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.authMethod,
      hostFingerprint: row.hostFingerprint,
      jumpConnectorId: row.jumpConnectorId,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async assertExternalTarget(host: string): Promise<string> {
    const normalized = host.trim().toLowerCase();
    if (
      [
        'gateway',
        'gateway-backend',
        'gateway-frontend',
        'gateway-daemon',
        'gateway-agent',
        'gateway-proxy',
        'postgres',
        'redis',
        'localhost',
      ].includes(normalized)
    ) {
      throw new AppError(403, 'SSH_GATEWAY_TARGET_BLOCKED', 'Gateway itself cannot be used as an external SSH target');
    }
    const addresses = await this.resolveHostAddresses(normalized);
    const gatewayAddresses = new Set(
      Object.values(networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .map((entry) => entry.address.toLowerCase())
    );
    if (addresses.some((address) => gatewayAddresses.has(address) || isLoopbackAddress(address))) {
      throw new AppError(403, 'SSH_GATEWAY_TARGET_BLOCKED', 'Gateway itself cannot be used as an external SSH target');
    }
    const nodeRows = await this.db.select({ hostname: nodes.hostname, report: nodes.lastHealthReport }).from(nodes);
    const matchesManagedNode = nodeRows.some((node) => {
      const report = node.report as { localIpAddresses?: string[]; publicIpAddresses?: string[] } | null;
      const nodeAddresses = new Set(
        [...(report?.localIpAddresses ?? []), ...(report?.publicIpAddresses ?? [])].map((address) =>
          address.toLowerCase()
        )
      );
      return node.hostname.toLowerCase() === normalized || addresses.some((address) => nodeAddresses.has(address));
    });
    if (matchesManagedNode) {
      throw new AppError(403, 'SSH_MANAGED_TARGET_BLOCKED', 'Gateway-managed nodes require their dedicated tools');
    }
    if (this.dockerService) {
      const containers = await this.dockerService.listLocalContainers().catch(() => []);
      const matchesContainer = containers.some((container) => {
        const names = container.Names.map((name) => name.replace(/^\//, '').toLowerCase());
        const containerAddresses = Object.values(container.NetworkSettings?.Networks ?? {}).flatMap((network) =>
          [network.IPAddress, network.GlobalIPv6Address]
            .filter((address): address is string => Boolean(address))
            .map((address) => address.toLowerCase())
        );
        return names.includes(normalized) || addresses.some((address) => containerAddresses.includes(address));
      });
      if (matchesContainer) {
        throw new AppError(
          403,
          'SSH_CONTAINER_TARGET_BLOCKED',
          'Gateway and container addresses require dedicated tools'
        );
      }
    }
    return addresses[0];
  }

  private async execConnector(connector: Connector, targetAddress: string, command: string) {
    const jump = connector.jumpConnectorId ? await this.get(connector.jumpConnectorId) : null;
    const jumpAddress = jump ? await this.assertExternalTarget(jump.host) : null;
    const jumpClient = jump && jumpAddress ? await this.connect(jump, undefined, jumpAddress) : null;
    try {
      const stream = jumpClient
        ? await new Promise<Parameters<Client['connect']>[0]['sock']>((resolve, reject) =>
            jumpClient.forwardOut('127.0.0.1', 0, targetAddress, connector.port, (error, socket) =>
              error ? reject(error) : resolve(socket)
            )
          )
        : undefined;
      const client = await this.connect(connector, stream, targetAddress);
      try {
        return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
          client.exec(command, (error, channel) => {
            if (error) return reject(error);
            let stdout = '';
            let stderr = '';
            channel.on('data', (chunk: Buffer) => (stdout = limitOutput(stdout, chunk.toString())));
            channel.stderr.on('data', (chunk: Buffer) => (stderr = limitOutput(stderr, chunk.toString())));
            channel.on('close', (code: number | null) => resolve({ stdout, stderr, exitCode: code }));
          });
        });
      } finally {
        client.end();
      }
    } finally {
      jumpClient?.end();
    }
  }

  private connect(connector: Connector, sock?: Parameters<Client['connect']>[0]['sock'], host?: string) {
    const secret = this.crypto.decryptString(JSON.parse(connector.encryptedSecret));
    const passphrase = connector.encryptedPassphrase
      ? this.crypto.decryptString(JSON.parse(connector.encryptedPassphrase))
      : undefined;
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      client.once('ready', () => resolve(client));
      client.once('error', reject);
      client.connect({
        host: host ?? connector.host,
        port: connector.port,
        username: connector.username,
        ...(connector.authMethod === 'password' ? { password: secret } : { privateKey: secret, passphrase }),
        ...(sock ? { sock } : {}),
        hostVerifier: (key: Buffer) => fingerprint(key) === connector.hostFingerprint,
        readyTimeout: 20_000,
      });
    });
  }

  private async resolveHostAddresses(host: string): Promise<string[]> {
    try {
      const entries = await lookup(host, { all: true, verbatim: true });
      const addresses = [...new Set(entries.map((entry) => entry.address.toLowerCase()))];
      if (addresses.length === 0) throw new Error('No addresses');
      return addresses;
    } catch {
      throw new AppError(400, 'SSH_HOST_UNRESOLVED', 'SSH target host could not be resolved');
    }
  }

  private assertScope(user: User, scope: string) {
    if (!hasScope(user.scopes, scope))
      throw new AppError(403, 'SSH_SCOPE_DENIED', 'Missing required SSH integration scope');
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address === '0:0:0:0:0:0:0:1' || address.startsWith('127.');
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function limitOutput(current: string, next: string): string {
  return `${current}${next}`.slice(0, 128 * 1024);
}

function toOpenSshEd25519PublicKey(jwk: { x?: string }): string {
  if (!jwk.x) throw new Error('Generated SSH public key is incomplete');
  const keyType = Buffer.from('ssh-ed25519');
  const key = Buffer.from(jwk.x, 'base64url');
  const encode = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  return `ssh-ed25519 ${Buffer.concat([encode(keyType), encode(key)]).toString('base64')}`;
}
