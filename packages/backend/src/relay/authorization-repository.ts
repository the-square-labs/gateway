import pg from 'pg';
import { RELAY_DATABASE_CONTRACT_VERSION, type RelayNodeType } from './protocol.js';

const { Pool } = pg;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELAY_NODE_TYPES = new Set<RelayNodeType>(['nginx', 'bastion', 'monitoring', 'docker', 'databases']);

export type RelayAuthorizationFailure = 'database_unavailable' | 'contract_mismatch';

export class RelayAuthorizationRepositoryError extends Error {
  constructor(
    readonly reason: RelayAuthorizationFailure,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RelayAuthorizationRepositoryError';
  }
}

export interface RelayQueryResult<Row> {
  rows: Row[];
}

export interface RelayQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<RelayQueryResult<Row>>;
  end?(): Promise<void>;
}

export interface RelayNodeIdentity {
  nodeId: string;
  nodeType: RelayNodeType;
}

export interface RelayBindingAuthorization {
  bindingId: string;
  managedDatabaseId: string;
  sourceNodeId: string;
  databaseNodeId: string;
}

export interface RelayManagedDatabaseAuthorization {
  managedDatabaseId: string;
  databaseNodeId: string;
}

export function normalizeRelayCertificateSerial(serial: string): string {
  return serial.trim().replace(/:/g, '').toLowerCase();
}

export class RelayAuthorizationRepository {
  private constructor(private readonly client: RelayQueryClient) {}

  static connect(connectionString: string): RelayAuthorizationRepository {
    const pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 2_000,
      query_timeout: 2_000,
      application_name: 'gateway-relay',
    });
    return new RelayAuthorizationRepository(pool);
  }

  static forTest(client: RelayQueryClient): RelayAuthorizationRepository {
    return new RelayAuthorizationRepository(client);
  }

  async close(): Promise<void> {
    await this.client.end?.();
  }

  async checkContract(): Promise<number> {
    try {
      await this.client.query(
        `SELECT
          (SELECT count(*) FROM gateway_relay_node_identities_v1 LIMIT 1),
          (SELECT count(*) FROM gateway_relay_managed_databases_v1 LIMIT 1),
          (SELECT count(*) FROM gateway_relay_bindings_v1 LIMIT 1)`
      );
      return RELAY_DATABASE_CONTRACT_VERSION;
    } catch (error) {
      throw this.classify(error, 'Relay database authorization contract is unavailable');
    }
  }

  async authenticateNode(nodeId: string, certificateSerial: string): Promise<RelayNodeIdentity | null> {
    if (!UUID_RE.test(nodeId)) return null;
    try {
      const result = await this.client.query<{
        node_id: string;
        node_type: string;
        node_status: string;
        certificate_serial: string | null;
      }>(
        `SELECT node_id, node_type, node_status, certificate_serial
         FROM gateway_relay_node_identities_v1
         WHERE node_id = $1
         LIMIT 1`,
        [nodeId]
      );
      const row = result.rows[0];
      if (
        !row ||
        row.node_status === 'pending' ||
        !RELAY_NODE_TYPES.has(row.node_type as RelayNodeType) ||
        !row.certificate_serial ||
        normalizeRelayCertificateSerial(row.certificate_serial) !== normalizeRelayCertificateSerial(certificateSerial)
      ) {
        return null;
      }
      return { nodeId: row.node_id, nodeType: row.node_type as RelayNodeType };
    } catch (error) {
      throw this.classify(error, 'Relay node identity lookup failed');
    }
  }

  async authorizeBinding(
    bindingId: string,
    managedDatabaseId: string,
    sourceNodeId: string
  ): Promise<RelayBindingAuthorization | null> {
    if (!UUID_RE.test(bindingId) || !UUID_RE.test(managedDatabaseId) || !UUID_RE.test(sourceNodeId)) return null;
    try {
      const result = await this.client.query<{
        binding_id: string;
        managed_database_id: string;
        source_node_id: string;
        binding_status: string;
        database_node_id: string;
        database_status: string;
      }>(
        `SELECT binding_id, managed_database_id, source_node_id, binding_status,
                database_node_id, database_status
         FROM gateway_relay_bindings_v1
         WHERE binding_id = $1 AND managed_database_id = $2
         LIMIT 1`,
        [bindingId, managedDatabaseId]
      );
      const row = result.rows[0];
      if (
        !row ||
        row.source_node_id !== sourceNodeId ||
        row.binding_status !== 'ready' ||
        row.database_status !== 'ready'
      ) {
        return null;
      }
      return {
        bindingId: row.binding_id,
        managedDatabaseId: row.managed_database_id,
        sourceNodeId: row.source_node_id,
        databaseNodeId: row.database_node_id,
      };
    } catch (error) {
      throw this.classify(error, 'Relay binding authorization lookup failed');
    }
  }

  async authorizeManagedDatabase(managedDatabaseId: string): Promise<RelayManagedDatabaseAuthorization | null> {
    if (!UUID_RE.test(managedDatabaseId)) return null;
    try {
      const result = await this.client.query<{
        managed_database_id: string;
        database_node_id: string;
        database_status: string;
      }>(
        `SELECT managed_database_id, database_node_id, database_status
         FROM gateway_relay_managed_databases_v1
         WHERE managed_database_id = $1
         LIMIT 1`,
        [managedDatabaseId]
      );
      const row = result.rows[0];
      if (!row || row.database_status !== 'ready') return null;
      return { managedDatabaseId: row.managed_database_id, databaseNodeId: row.database_node_id };
    } catch (error) {
      throw this.classify(error, 'Relay managed database authorization lookup failed');
    }
  }

  async readyBindingIds(bindingIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(bindingIds.filter((id) => UUID_RE.test(id)))];
    if (ids.length === 0) return new Set();
    try {
      const result = await this.client.query<{ binding_id: string }>(
        `SELECT binding_id
         FROM gateway_relay_bindings_v1
         WHERE binding_id = ANY($1::uuid[])
           AND binding_status = 'ready'
           AND database_status = 'ready'`,
        [ids]
      );
      return new Set(result.rows.map((row) => row.binding_id));
    } catch (error) {
      throw this.classify(error, 'Relay binding reconciliation failed');
    }
  }

  private classify(error: unknown, message: string): RelayAuthorizationRepositoryError {
    const code = (error as { code?: unknown })?.code;
    const reason: RelayAuthorizationFailure =
      code === '42P01' || code === '42703' ? 'contract_mismatch' : 'database_unavailable';
    return new RelayAuthorizationRepositoryError(reason, message, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
