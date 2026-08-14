import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { eq } from 'drizzle-orm';
import ssh2, { Client } from 'ssh2';
import type { DrizzleClient } from '@/db/client.js';
import { externalSshConnectors, nodes } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DockerService } from '@/services/docker.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';

type Connector = typeof externalSshConnectors.$inferSelect;
const SSH_CONNECT_TIMEOUT_MS = 10_000;
const SSH_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const { utils: sshUtils } = ssh2;

export interface ExternalSshConnectorInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: 'password' | 'private_key';
  secret?: string;
  hostFingerprint: string;
  jumpConnectorId?: string | null;
  enabled?: boolean;
  generatePrivateKey?: boolean;
  reuseCredentialFromConnectorId?: string;
}

export interface ExternalSshHostKeyInput {
  host: string;
  port?: number;
  jumpConnectorId?: string | null;
}

export class ExternalSshService {
  private dockerService: DockerService | null = null;
  private eventBus: EventBusService | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly crypto: CryptoService
  ) {}

  setDockerService(service: DockerService) {
    this.dockerService = service;
  }

  setEventBus(service: EventBusService) {
    this.eventBus = service;
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
    if (input.generatePrivateKey && input.reuseCredentialFromConnectorId) {
      throw new AppError(400, 'SSH_KEY_SOURCE_INVALID', 'Generate or reuse an SSH key, not both');
    }
    if ((input.generatePrivateKey || input.reuseCredentialFromConnectorId) && input.authMethod !== 'private_key') {
      throw new AppError(400, 'SSH_KEY_GENERATION_INVALID', 'Generated keys require private-key authentication');
    }
    if (input.authMethod === 'private_key' && !input.generatePrivateKey && !input.reuseCredentialFromConnectorId) {
      throw new AppError(
        400,
        'SSH_PRIVATE_KEY_IMPORT_DISABLED',
        'Private key import is disabled; generate a new key instead'
      );
    }
    let secret = input.secret?.trim() ?? '';
    let generatedPublicKey: string | null = null;
    if (input.reuseCredentialFromConnectorId) {
      const source = await this.get(input.reuseCredentialFromConnectorId);
      if (!source.enabled || source.authMethod !== 'private_key') {
        throw new AppError(
          409,
          'SSH_KEY_SOURCE_INVALID',
          'The selected jump connector does not provide an enabled private key'
        );
      }
      secret = this.crypto.decryptString(JSON.parse(source.encryptedSecret));
    }
    if (input.generatePrivateKey) {
      const pair = sshUtils.generateKeyPairSync('ed25519');
      secret = pair.private;
      generatedPublicKey = pair.public;
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
        encryptedPassphrase: null,
        hostFingerprint: input.hostFingerprint.trim(),
        jumpConnectorId: input.jumpConnectorId ?? null,
        enabled: input.enabled ?? true,
        createdBy: user.id,
      })
      .returning();
    this.emitConnector(created.id, 'created', created.name);
    return { connector: this.safe(created), generatedPublicKey };
  }

  async test(user: User, id: string, signal?: AbortSignal) {
    this.assertScope(user, 'integrations:ssh:manage');
    const connector = await this.get(id);
    try {
      await this.checkConnector(connector, signal);
      await this.recordTestResult(connector.id, 'success', null);
      this.emitConnector(connector.id, 'tested', connector.name);
      return { success: true as const };
    } catch (error) {
      const mapped = error instanceof AppError ? error : mapSshConnectionError(error, 'target');
      await this.recordTestResult(connector.id, 'error', mapped.message);
      this.emitConnector(connector.id, 'tested', connector.name);
      throw mapped;
    }
  }

  async updateName(user: User, id: string, name: string) {
    this.assertScope(user, 'integrations:ssh:manage');
    await this.get(id);
    const [updated] = await this.db
      .update(externalSshConnectors)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(eq(externalSshConnectors.id, id))
      .returning();
    this.emitConnector(updated.id, 'updated', updated.name);
    return this.safe(updated);
  }

  async runDueHealthChecks() {
    const connectors = await this.db
      .select()
      .from(externalSshConnectors)
      .where(eq(externalSshConnectors.enabled, true));
    const now = Date.now();
    for (const connector of connectors) {
      if (connector.testedAt && now - connector.testedAt.getTime() < SSH_HEALTH_CHECK_INTERVAL_MS) continue;
      try {
        await this.checkConnector(connector);
        await this.recordTestResult(connector.id, 'success', null);
      } catch (error) {
        const mapped = error instanceof AppError ? error : mapSshConnectionError(error, 'target');
        await this.recordTestResult(connector.id, 'error', mapped.message);
      }
      this.emitConnector(connector.id, 'tested', connector.name);
    }
  }

  async delete(user: User, id: string) {
    this.assertScope(user, 'integrations:ssh:manage');
    const connector = await this.get(id);
    const [dependent] = await this.db
      .select({ id: externalSshConnectors.id })
      .from(externalSshConnectors)
      .where(eq(externalSshConnectors.jumpConnectorId, id))
      .limit(1);
    if (dependent) {
      throw new AppError(
        409,
        'SSH_CONNECTOR_IN_USE',
        'This SSH connector is used as a jump server and cannot be deleted'
      );
    }
    await this.db.delete(externalSshConnectors).where(eq(externalSshConnectors.id, id));
    this.emitConnector(connector.id, 'deleted', connector.name);
    return { success: true as const };
  }

  async discoverHostKey(user: User, input: ExternalSshHostKeyInput, signal?: AbortSignal) {
    this.assertScope(user, 'integrations:ssh:manage');
    const host = input.host.trim();
    const port = input.port ?? 22;
    const targetAddress = await this.assertExternalTarget(host);
    const jump = input.jumpConnectorId ? await this.get(input.jumpConnectorId) : null;
    if (jump && !jump.enabled) {
      throw new AppError(409, 'SSH_JUMP_CONNECTOR_DISABLED', 'The selected jump server is disabled');
    }
    const jumpAddress = jump ? await this.assertExternalTarget(jump.host) : null;
    let jumpClient: Client | null = null;
    try {
      if (jump && jumpAddress) {
        try {
          jumpClient = await this.connect(jump, undefined, jumpAddress, signal);
        } catch (error) {
          throw mapSshConnectionError(error, 'jump');
        }
      }
      const stream = jumpClient ? await this.forwardThroughJump(jumpClient, targetAddress, port, signal) : undefined;
      const hostFingerprint = await this.readHostFingerprint(targetAddress, port, stream, signal);
      return { host, port, hostFingerprint };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        'SSH_HOST_KEY_DISCOVERY_FAILED',
        'Gateway could not read the SSH host key through the selected route'
      );
    } finally {
      jumpClient?.end();
    }
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
      testStatus: row.testStatus,
      testLastError: row.testLastError,
      testedAt: row.testedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async checkConnector(connector: Connector, signal?: AbortSignal) {
    if (!connector.enabled) throw new AppError(409, 'SSH_CONNECTOR_DISABLED', 'SSH connector is disabled');
    const targetAddress = await this.assertExternalTarget(connector.host);
    const jump = connector.jumpConnectorId ? await this.get(connector.jumpConnectorId) : null;
    const jumpAddress = jump ? await this.assertExternalTarget(jump.host) : null;
    let jumpClient: Client | null = null;
    try {
      if (jump && jumpAddress) {
        try {
          jumpClient = await this.connect(jump, undefined, jumpAddress, signal);
        } catch (error) {
          throw mapSshConnectionError(error, 'jump');
        }
      }
      const stream = jumpClient
        ? await this.forwardThroughJump(jumpClient, targetAddress, connector.port, signal)
        : undefined;
      let client: Client;
      try {
        client = await this.connect(connector, stream, targetAddress, signal);
      } catch (error) {
        throw mapSshConnectionError(error, 'target');
      }
      client.end();
    } finally {
      jumpClient?.end();
    }
  }

  private async recordTestResult(id: string, status: 'success' | 'error', error: string | null) {
    await this.db
      .update(externalSshConnectors)
      .set({ testStatus: status, testLastError: error, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(externalSshConnectors.id, id));
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
      const stream = jumpClient ? await this.forwardThroughJump(jumpClient, targetAddress, connector.port) : undefined;
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

  private connect(
    connector: Connector,
    sock?: Parameters<Client['connect']>[0]['sock'],
    host?: string,
    signal?: AbortSignal
  ) {
    const secret = this.crypto.decryptString(JSON.parse(connector.encryptedSecret));
    const passphrase = connector.encryptedPassphrase
      ? this.crypto.decryptString(JSON.parse(connector.encryptedPassphrase))
      : undefined;
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      const abort = () => {
        client.destroy();
        reject(new AppError(499, 'SSH_OPERATION_CANCELLED', 'SSH operation was cancelled'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      client.once('ready', () => {
        signal?.removeEventListener('abort', abort);
        resolve(client);
      });
      client.once('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      client.connect({
        host: host ?? connector.host,
        port: connector.port,
        username: connector.username,
        ...(connector.authMethod === 'password' ? { password: secret } : { privateKey: secret, passphrase }),
        ...(sock ? { sock } : {}),
        hostVerifier: (key: Buffer) => fingerprint(key) === connector.hostFingerprint,
        readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      });
    });
  }

  private readHostFingerprint(
    host: string,
    port: number,
    sock?: Parameters<Client['connect']>[0]['sock'],
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(new AppError(499, 'SSH_OPERATION_CANCELLED', 'SSH host-key check was cancelled'));
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        reject(error);
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      client.once('error', fail);
      client.connect({
        host,
        port,
        username: 'gateway-host-key-probe',
        ...(sock ? { sock } : {}),
        hostVerifier: (key: Buffer) => {
          if (!settled) {
            settled = true;
            signal?.removeEventListener('abort', abort);
            resolve(fingerprint(key));
          }
          queueMicrotask(() => client.end());
          return false;
        },
        readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      });
    });
  }

  private forwardThroughJump(
    client: Client,
    targetAddress: string,
    port: number,
    signal?: AbortSignal
  ): Promise<Parameters<Client['connect']>[0]['sock']> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, socket?: Parameters<Client['connect']>[0]['sock']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (socket) resolve(socket);
      };
      const abort = () => finish(new AppError(499, 'SSH_OPERATION_CANCELLED', 'SSH operation was cancelled'));
      const timeout = setTimeout(
        () => finish(new AppError(504, 'SSH_CONNECT_TIMEOUT', 'SSH connection timed out after 10 seconds')),
        SSH_CONNECT_TIMEOUT_MS
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      client.forwardOut('127.0.0.1', 0, targetAddress, port, (error, socket) => finish(error ?? undefined, socket));
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

  private emitConnector(id: string, action: string, name: string) {
    this.eventBus?.publish('integration.connector.changed', { id, provider: 'ssh', action, name });
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

function mapSshConnectionError(error: unknown, role: 'jump' | 'target'): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : '';
  const level = (error as { level?: unknown } | null)?.level;
  const connectorLabel = role === 'jump' ? 'jump connector' : 'SSH connector';
  const serverLabel = role === 'jump' ? 'jump server' : 'SSH server';
  if (/cannot parse privatekey|unsupported key format/i.test(message)) {
    return new AppError(
      409,
      role === 'jump' ? 'SSH_JUMP_CREDENTIAL_INVALID' : 'SSH_CREDENTIAL_INVALID',
      `The ${connectorLabel} contains an incompatible private key. Recreate it and install the newly generated public key.`
    );
  }
  if (level === 'client-authentication' || /authentication methods failed|permission denied/i.test(message)) {
    return new AppError(
      401,
      role === 'jump' ? 'SSH_JUMP_AUTHENTICATION_FAILED' : 'SSH_AUTHENTICATION_FAILED',
      `Gateway could not authenticate to the ${serverLabel}. Check that the configured password or generated public key is installed for the SSH user, then try again.`
    );
  }
  return new AppError(
    502,
    role === 'jump' ? 'SSH_JUMP_CONNECTION_FAILED' : 'SSH_CONNECTION_FAILED',
    `Gateway could not connect to the ${serverLabel} with the configured SSH credential.`
  );
}
