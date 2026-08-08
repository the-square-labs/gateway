import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url));
const nginxNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-node.sh', import.meta.url));
const dockerNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-docker-node.sh', import.meta.url));
const monitoringNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-monitoring-node.sh', import.meta.url));

describe('install.sh managed browser bootstrap', () => {
  it('is valid shell and still works when piped to bash', () => {
    const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const result = spawnSync('bash', ['-s', '--', '--help'], {
      encoding: 'utf8',
      input: readFileSync(installer, 'utf8'),
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Usage: install.sh');
  });

  it('keeps transport as the only product choice and delegates setup to the browser', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('Web transport:');
    expect(source).toContain('Internal HTTPS  — use Gateway System CA on :3000');
    expect(source).toContain('Finish configuration in the browser');
    expect(source).not.toMatch(/^OIDC_ISSUER=/m);
    expect(source).not.toMatch(/^CLICKHOUSE_URL=/m);
    expect(source).not.toMatch(/^SETUP_TOKEN=/m);
    expect(source).not.toContain('nginx');
    expect(source).not.toContain('cloudflare');
  });

  it('can build a fresh test install from a local source checkout without GitLab release discovery', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('--source-dir PATH');
    expect(source).toContain('Building Gateway from local source');
    expect(source).toMatch(/run_quiet "Gateway image build" "\$\{DOCKER\[@\]\}" build/);
    expect(source).toContain('--source-dir is supported only for a fresh Gateway installation');
    expect(source).toContain(
      'ensure_env GATEWAY_RELAY_MANAGED "$([[ -z "$SOURCE_DIR" ]] && printf true || printf false)"'
    );
    expect(source).toContain('GATEWAY_RELAY_MANAGED: "${GATEWAY_RELAY_MANAGED:-true}"');
  });

  it('renders a compact, quiet installer and lists usable connection URLs', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain("BRAND_MINT='\\033[38;2;140;176;132m'");
    expect(source).toContain('Gateway Installer');
    expect(source).not.toContain('show_logo()');
    expect(source).toMatch(/run_quiet "Gateway service startup" "\$\{DOCKER\[@\]\}" compose up -d/);
    expect(source).toContain('print_gateway_urls');
    expect(source).not.toContain('<server-ip>');
  });

  it('pins production installs to a verified signed image digest and labels local checksums', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('verify_signed_release');
    expect(source).toContain('decode_base64url');
    expect(source).toContain('openssl pkeyutl -verify -rawin -pubin');
    expect(source).toContain('gateway-image.update.json');
    expect(source).toContain('IMAGE_REF="$image_ref"');
    expect(source).toContain('databaseConnectorImage');
    expect(source).toContain('DATABASE_CONNECTOR_IMAGE_REF="$connector_image_ref"');
    expect(source).toContain('RELAY_VERSION="$relay_version"');
    expect(source).toContain('GATEWAY_RELAY_IMAGE_REF');
    expect(source).toContain('gateway_relay_identity:/var/lib/gateway-relay:ro');
    expect(source).toContain('      - "9443:9443"');
    expect(source).toContain('Gateway recovery helper image pull');
    expect(source).toContain('--database-connector-image "$DATABASE_CONNECTOR_IMAGE_REF"');
    expect(source).toContain('ARTIFACT_KIND="local source checksum"');
    expect(source).toContain('short_digest "$ARTIFACT_DIGEST"');
  });

  it('does not advertise Docker, CNI, or loopback interface addresses as host-local targets', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('ip -o addr show up scope global');
    expect(source).toContain('interface ~ /^docker/');
    expect(source).toContain('interface ~ /^br-/');
    expect(source).toContain('interface ~ /^veth/');
    expect(source).toContain('interface ~ /^cni/');
    expect(source).toContain('interface ~ /^tailscale/');
    expect(source).toContain('address != "::1" && address !~ /^fe80:/');
  });
});

describe('database daemon installer prerequisites', () => {
  it('keeps the shared Docker-node installer valid shell', () => {
    const syntax = spawnSync('bash', ['-n', dockerNodeInstaller], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('proves the runtime-equivalent fixed-size ext4 image lifecycle before enrollment', () => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');
    expect(source).toContain('losetup --find --show --nooverlap "$image"');
    expect(source).toContain('mount -o noatime "$DATABASE_PREFLIGHT_LOOP_DEVICE"');
    expect(source).toContain('fallocate -l 64M "$image"');
    expect(source).toContain('fallocate -l 128M "$image"');
    expect(source).toContain('losetup -c "$DATABASE_PREFLIGHT_LOOP_DEVICE"');
    expect(source).toContain('resize2fs "$DATABASE_PREFLIGHT_LOOP_DEVICE"');
    expect(source).toContain('blockdev --getsize64 "$DATABASE_PREFLIGHT_LOOP_DEVICE"');
    expect(source).toContain('Storage filesystem created a sparse image');
  });

  it('cleans failed probes and explains unsupported LXC hosts', () => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');
    expect(source).toContain('trap cleanup_database_preflight EXIT');
    expect(source).toContain('umount "$DATABASE_PREFLIGHT_MOUNT_DIR"');
    expect(source).toContain('losetup -d "$DATABASE_PREFLIGHT_LOOP_DEVICE"');
    expect(source).toContain('This host is an LXC guest.');
    expect(source).toContain('pass /dev/loop-control and a loop-device pool');
  });

  it('checks the local Docker Engine after host storage and before daemon enrollment', () => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');
    const ensureDocker = source.lastIndexOf('\nensure_docker_installed\n');
    const dockerPreflight = source.lastIndexOf('\npreflight_database_docker\n');
    const enrollDaemon = source.lastIndexOf('\nenroll_daemon\n');

    expect(ensureDocker).toBeGreaterThanOrEqual(0);
    expect(dockerPreflight).toBeGreaterThan(ensureDocker);
    expect(enrollDaemon).toBeGreaterThan(dockerPreflight);
    expect(source).toContain('Database nodes require a local Docker Engine socket');
  });
});

describe('node installer private logs', () => {
  it.each([
    ['nginx', nginxNodeInstaller, 'gateway_node_setup'],
    ['docker', dockerNodeInstaller, 'gateway_docker_setup'],
    ['monitoring', monitoringNodeInstaller, 'gateway_monitoring_setup'],
  ])('%s creates its private log before dependency work', (_name, path, logPrefix) => {
    const source = readFileSync(path, 'utf8');
    const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const needRoot = source.lastIndexOf('\nneed_root\n');
    const privateLog = source.indexOf(`LOG_FILE=$(mktemp /tmp/${logPrefix}.XXXXXX)`);
    const dependencyCheck = source.lastIndexOf('\ncheck_dependencies\n');

    expect(needRoot).toBeGreaterThanOrEqual(0);
    expect(privateLog).toBeGreaterThan(needRoot);
    expect(privateLog).toBeLessThan(dependencyCheck);
    expect(source).toContain('chmod 600 "$LOG_FILE"');
    expect(source).toContain('LOG_FILE="/dev/null"');
  });
});
