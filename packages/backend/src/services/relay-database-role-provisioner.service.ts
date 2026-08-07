import pg from 'pg';

const { Pool } = pg;

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export class RelayDatabaseRoleProvisionerService {
  constructor(
    private readonly databaseUrl: string,
    private readonly relayPassword: string | undefined
  ) {}

  async ensure(): Promise<boolean> {
    if (!this.relayPassword) return false;
    if (this.relayPassword.length < 24) throw new Error('GATEWAY_RELAY_DB_PASSWORD must be at least 24 characters');
    const pool = new Pool({
      connectionString: this.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      application_name: 'gateway-relay-role-provisioner',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const database = await client.query<{ current_database: string }>('SELECT current_database()');
      const databaseName = database.rows[0]?.current_database;
      if (!databaseName) throw new Error('Could not determine Gateway database name');
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_relay') THEN
          CREATE ROLE gateway_relay;
        END IF;
      END $$`);
      await client.query(
        `ALTER ROLE gateway_relay WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(
          this.relayPassword
        )}`
      );
      await client.query('ALTER ROLE gateway_relay SET default_transaction_read_only = on');
      await client.query("ALTER ROLE gateway_relay SET statement_timeout = '2s'");
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO gateway_relay`);
      await client.query('GRANT USAGE ON SCHEMA public TO gateway_relay');
      await client.query('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gateway_relay');
      await client.query(
        `GRANT SELECT ON
          gateway_relay_node_identities_v1,
          gateway_relay_managed_databases_v1,
          gateway_relay_bindings_v1
        TO gateway_relay`
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
}
