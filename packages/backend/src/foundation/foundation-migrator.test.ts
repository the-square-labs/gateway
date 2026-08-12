import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchCompose, patchEnv, runFoundationMigrations } from './foundation-migrator.js';

const OLD_COMPOSE = `services:
  app:
    image: \${GATEWAY_IMAGE}:\${GATEWAY_VERSION}
    restart: unless-stopped
    env_file: .env
    mem_limit: 1g
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./docker-compose.yml:/app/docker-compose.yml:ro
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health"]

  redis:
    image: redis:7-alpine
`;
const DOLLAR = '$';
const EXPECTED_IMAGE_LINE = `image: ${DOLLAR}{GATEWAY_IMAGE_REF}`;
const EXPECTED_SANDBOX_VOLUME =
  `      - ${DOLLAR}{SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:` +
  `${DOLLAR}{SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}`;
const BUILD_ONLY_APP_COMPOSE = `services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./docker-compose.yml:/app/docker-compose.yml:ro
`;

describe('foundation migrator patches', () => {
  it('ensures at least sixty seconds of app stop grace', () => {
    const added = patchCompose(OLD_COMPOSE);
    expect(added).toContain('    stop_grace_period: 60s');
    expect(patchCompose(added)).toBe(added);

    const raised = patchCompose(
      OLD_COMPOSE.replace('    restart: unless-stopped', '    restart: unless-stopped\n    stop_grace_period: 30s')
    );
    expect(raised).toContain('    stop_grace_period: 60s');

    const preserved = patchCompose(
      OLD_COMPOSE.replace('    restart: unless-stopped', '    restart: unless-stopped\n    stop_grace_period: 2m')
    );
    expect(preserved).toContain('    stop_grace_period: 2m');
  });

  it('adds the managed sandbox volume and normalizes the app image reference', () => {
    const patched = patchCompose(OLD_COMPOSE);

    expect(patched).toContain(EXPECTED_IMAGE_LINE);
    expect(patched).toContain('      # gateway-managed:start sandbox-workspace');
    expect(patched).toContain(EXPECTED_SANDBOX_VOLUME);
    expect(patched).toContain('      # gateway-managed:end sandbox-workspace');
    expect(patched).toContain('      - /var/run/docker.sock:/var/run/docker.sock\n');
    expect(patched).toContain('      - gateway_data:/var/lib/gateway');
    expect(patched).toContain('wget --no-check-certificate -qO- https://127.0.0.1:3000/health');
    expect(patched).toContain('\nvolumes:\n  gateway_data:');
    expect(patched).toContain(`  relay:\n    image: \${GATEWAY_RELAY_IMAGE_REF}`);
    expect(patched).toContain('    entrypoint: ["/gateway-relay"]');
    expect(patched).toContain('com.wiolett.gateway.managed-service: app');
    expect(patched).toContain('gateway_relay_identity:/var/lib/gateway-relay');
    expect(patched).toContain('gateway_relay_state:/var/lib/gateway-relay/state');
    expect(patched).toContain('      relay:\n        condition: service_started');
    expect(patched).not.toContain('RELAY_DATABASE_URL');
    expect(patched).not.toContain('GATEWAY_RELAY_DB_PASSWORD');
    expect(patched.match(/9443:9443/g)).toHaveLength(1);
    expect(patchCompose(patched)).toBe(patched);
  });

  it('replaces legacy relay IP targets with the Compose service DNS name', () => {
    const mappingStyle = OLD_COMPOSE.replace(
      '    env_file: .env',
      '    env_file: .env\n    environment:\n      GATEWAY_RELAY_TARGET: 172.18.0.4:9443'
    );
    const listStyle = OLD_COMPOSE.replace(
      '    env_file: .env',
      '    env_file: .env\n    environment:\n      - GATEWAY_RELAY_TARGET=172.18.0.4:9443'
    );

    for (const compose of [mappingStyle, listStyle]) {
      const patched = patchCompose(compose);
      expect(patched).toContain('GATEWAY_RELAY_TARGET: relay:9443');
      expect(patched).not.toContain('172.18.0.4:9443');
      expect(patched.match(/GATEWAY_RELAY_TARGET/g)).toHaveLength(1);
    }
  });

  it('normalizes an existing relay dependency without duplicating it', () => {
    const compose = OLD_COMPOSE.replace(
      '    depends_on:\n      redis:',
      '    depends_on:\n      relay:\n        condition: service_healthy\n      redis:'
    );

    const patched = patchCompose(compose);
    expect(patched.match(/^\s+relay:$/gm)).toHaveLength(2);
    expect(patched).toContain('      relay:\n        condition: service_started');
    expect(patched).not.toContain('condition: service_healthy\n      redis:');
    expect(patchCompose(patched)).toBe(patched);
  });

  it('replaces the pre-v2.5 build-only app definition with the pinned release image', () => {
    const patched = patchCompose(BUILD_ONLY_APP_COMPOSE);

    expect(patched).toContain(EXPECTED_IMAGE_LINE);
    expect(patched).not.toContain('    build:');
    expect(patched).not.toContain('      context: .');
    expect(patched).not.toContain('      dockerfile: Dockerfile');
  });

  it('removes legacy OIDC and ClickHouse wiring without disturbing unrelated configuration', () => {
    const compose = `${OLD_COMPOSE.replace(
      '    env_file: .env',
      `    env_file: .env
    environment:
      OIDC_ISSUER_URL: \${OIDC_ISSUER_URL}
      - OIDC_CLIENT_SECRET=\${OIDC_CLIENT_SECRET}
      CLICKHOUSE_URL: http://clickhouse:8123
      APP_URL: \${APP_URL}
      SETUP_TOKEN: \${SETUP_TOKEN}
      OTHER_SETTING: keep-me`
    ).replace(
      '      redis:\n        condition: service_healthy',
      '      redis:\n        condition: service_healthy\n      clickhouse:\n        condition: service_healthy'
    )}

  clickhouse:
    image: clickhouse/clickhouse-server:latest
    volumes:
      - clickhouse_data:/var/lib/clickhouse

volumes:
  clickhouse_data:
  redis_data:
`;

    const patched = patchCompose(compose);

    expect(patched).not.toMatch(/OIDC_|CLICKHOUSE_|APP_URL|SETUP_TOKEN/);
    expect(patched).not.toContain('\n  clickhouse:');
    expect(patched).not.toContain('clickhouse_data:');
    expect(patched).toContain('OTHER_SETTING: keep-me');
    expect(patched).toContain('\n  redis:\n');
    expect(patched).toContain('  redis_data:');
    expect(patched).toContain('  gateway_data:');
  });

  it('keeps an existing runtime storage mount instead of adding a managed volume', () => {
    const compose = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      '      - /srv/gateway-state:/var/lib/gateway\n      - ./docker-compose.yml:/app/docker-compose.yml:ro'
    );

    const patched = patchCompose(compose);

    expect(patched).toContain('/srv/gateway-state:/var/lib/gateway');
    expect(patched).not.toContain('gateway_data:/var/lib/gateway');
  });

  it('replaces an existing unmarked sandbox volume instead of duplicating it', () => {
    const compose = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      [
        '      - /var/lib/gateway/sandbox-workspaces:/var/lib/gateway/sandbox-workspaces',
        '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      ].join('\n')
    );
    const patched = patchCompose(compose);

    expect(patched.match(/sandbox-workspaces/g)).toHaveLength(2);
    expect(patched).toContain('# gateway-managed:start sandbox-workspace');
  });

  it('only patches the app service under services', () => {
    const compose = `app:
  image: unrelated/top-level:latest
  volumes:
    - ./top:/top

${OLD_COMPOSE}`;
    const patched = patchCompose(compose);

    expect(patched).toContain('app:\n  image: unrelated/top-level:latest');
    expect(patched).toContain(`    ${EXPECTED_IMAGE_LINE}`);
    expect(patched).toContain(EXPECTED_SANDBOX_VOLUME);
  });

  it('refuses malformed managed blocks', () => {
    const compose = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      '      # gateway-managed:start sandbox-workspace\n      - ./docker-compose.yml:/app/docker-compose.yml:ro'
    );

    expect(() => patchCompose(compose)).toThrow('malformed sandbox workspace managed block');
  });

  it('upserts env keys without leaving duplicates', () => {
    const patched = patchEnv('GATEWAY_VERSION=v2.4.2\nGATEWAY_VERSION=old\nOTHER=value\n', {
      GATEWAY_VERSION: 'v2.4.3',
      GATEWAY_IMAGE_REF: 'registry/gateway:v2.4.3',
    }).content;

    expect(patched).toBe('GATEWAY_VERSION=v2.4.3\nOTHER=value\n\nGATEWAY_IMAGE_REF=registry/gateway:v2.4.3\n');
  });
});

describe('runFoundationMigrations', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('patches host foundation files and writes backups only when files change', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(
      path.join(tempDir, '.env'),
      'GATEWAY_VERSION=v2.4.2\nGATEWAY_RELAY_TARGET=172.18.0.4:9443\nGATEWAY_RELAY_VERSION=1\nGATEWAY_RELAY_DB_PASSWORD=legacy-secret\nRELAY_DATABASE_URL=postgres://legacy\n'
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);
    const sandboxWorkspaceDir = path.join(tempDir, 'sandbox-workspaces');

    const first = await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.3',
      imageRef: 'registry/gateway:v2.4.3',
      databaseConnectorImage: 'registry/gateway/database-connector@sha256:connector',
      secureLinkConnectorImage: 'registry/gateway/secure-link-connector@sha256:secure-connector',
      relayBuildVersion: 'v2.4.3-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
      sandboxWorkspaceDir,
    });
    const second = await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.3',
      imageRef: 'registry/gateway:v2.4.3',
      databaseConnectorImage: 'registry/gateway/database-connector@sha256:connector',
      secureLinkConnectorImage: 'registry/gateway/secure-link-connector@sha256:secure-connector',
      relayBuildVersion: 'v2.4.3-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
      sandboxWorkspaceDir,
    });

    expect(first.changedFiles).toEqual(['.env', 'docker-compose.yml']);
    expect(first.backupDir).toContain('.gateway-foundation-backups');
    expect(second.changedFiles).toEqual([]);
    expect(second.backupDir).toBeNull();
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain('GATEWAY_IMAGE_REF=registry/gateway:v2.4.3');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain(
      'DATABASE_CONNECTOR_IMAGE=registry/gateway/database-connector@sha256:connector'
    );
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain(
      'SECURE_LINK_CONNECTOR_IMAGE=registry/gateway/secure-link-connector@sha256:secure-connector'
    );
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain(
      `GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}`
    );
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain('GATEWAY_RELAY_TARGET=relay:9443');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('172.18.0.4:9443');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('GATEWAY_RELAY_DB_PASSWORD');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('GATEWAY_RELAY_VERSION');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('RELAY_DATABASE_URL');
    expect(await readFile(path.join(tempDir, 'docker-compose.yml'), 'utf8')).toContain(
      '# gateway-managed:start sandbox-workspace'
    );
  });

  it('keeps the relay image pinned when the signed relay digest is unchanged', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(
      path.join(tempDir, '.env'),
      `GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}\nGATEWAY_RELAY_BUILD_VERSION=v2.4.3-relay\nGATEWAY_RELAY_PROTOCOL_MAJOR=1\n`
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.4',
      imageRef: 'registry/gateway@sha256:new',
      relayBuildVersion: 'v2.4.4-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
    });

    const env = await readFile(path.join(tempDir, '.env'), 'utf8');
    expect(env).toContain('GATEWAY_IMAGE_REF=registry/gateway@sha256:new');
    expect(env).toContain(`GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}`);
    expect(env).toContain('GATEWAY_RELAY_BUILD_VERSION=v2.4.3-relay');
    expect(env).not.toContain('GATEWAY_RELAY_BUILD_VERSION=v2.4.4-relay');
  });

  it('advances the relay image only when the signed relay digest changes', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(
      path.join(tempDir, '.env'),
      `GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}\n`
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await runFoundationMigrations({
      hostDir: tempDir,
      imageRef: 'registry/gateway@sha256:new',
      relayBuildVersion: 'v2.4.5-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'b'.repeat(64)}`,
    });

    const env = await readFile(path.join(tempDir, '.env'), 'utf8');
    expect(env).toContain(`GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'b'.repeat(64)}`);
  });

  it('rejects an unsupported relay protocol major', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(path.join(tempDir, '.env'), '');
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await expect(
      runFoundationMigrations({
        hostDir: tempDir,
        imageRef: 'registry/gateway@sha256:new',
        relayProtocolMajor: 2,
        relayImageRef: `registry/gateway/relay@sha256:${'b'.repeat(64)}`,
      })
    ).rejects.toThrow('does not support relay protocol major 2');
  });
});
