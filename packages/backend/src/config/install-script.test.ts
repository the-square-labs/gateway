import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url));
const gitlabPipeline = fileURLToPath(new URL('../../../../.gitlab-ci.yml', import.meta.url));
const relayMinGatewayVersion = fileURLToPath(new URL('../../../../config/relay/min-gateway-version', import.meta.url));
const nginxNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-node.sh', import.meta.url));
const dockerNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-docker-node.sh', import.meta.url));
const monitoringNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-monitoring-node.sh', import.meta.url));
const daemonInstaller = fileURLToPath(new URL('../../../../scripts/setup-daemon.sh', import.meta.url));
const relayNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-relay-node.sh', import.meta.url));

describe('setup-relay-node.sh', () => {
  it('verifies separately scoped supervisor and worker artifacts and installs rollback supervision', () => {
    const syntax = spawnSync('bash', ['-n', relayNodeInstaller], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const source = readFileSync(relayNodeInstaller, 'utf8');
    expect(source).toContain('fetch_verified "$SUPERVISOR" relay');
    expect(source).toContain('fetch_verified "$WORKER" relay-worker');
    expect(source).toContain('openssl pkeyutl -verify');
    expect(source).toContain('run-supervisor');
    expect(source).toContain('.update-pending');
    expect(source).toContain('mv -f "$previous" "$binary"');
    expect(source).toContain('ExecStart=/usr/local/lib/gateway-relay/run-supervisor');
  });
});

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
    expect(source).toContain(`GATEWAY_RELAY_MANAGED: "\${GATEWAY_RELAY_MANAGED:-true}"`);
  });

  it('keeps missing conflict packages from blocking Docker bootstrap', () => {
    const source = readFileSync(installer, 'utf8');
    const cleanupStart = source.indexOf('remove_conflicting_docker_packages()');
    const installStart = source.indexOf('install_docker_engine()');
    const cleanup = source.slice(cleanupStart, installStart);

    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(installStart).toBeGreaterThan(cleanupStart);
    expect(source).toContain('run_root_best_effort()');
    expect(cleanup).toContain('run_root_best_effort "Removing conflicting Docker packages" apt-get remove -y');
    expect(cleanup).toContain('run_root_best_effort "Removing conflicting Docker packages" dnf remove -y');
    expect(cleanup).toContain('run_root_best_effort "Removing conflicting Docker packages" yum remove -y');
    expect(cleanup).not.toContain('run_root_quiet "Removing conflicting Docker packages"');
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
    expect(source).toContain('verify_signed_relay');
    expect(source).toContain('relay-image.update.json');
    expect(source).not.toContain('gateway_update_requires_relay');
    expect(source).toContain('version_is_newer "$relay_version" "$current_relay_version"');
    expect(source).toContain('IMAGE_REF="$image_ref"');
    expect(source).toContain('databaseConnectorImage');
    expect(source).toContain('DATABASE_CONNECTOR_IMAGE_REF="$connector_image_ref"');
    expect(source).toContain('secureLinkConnectorImage');
    expect(source).toContain('SECURE_LINK_CONNECTOR_IMAGE_REF="$secure_connector_image_ref"');
    expect(source).toContain('Signed relay manifest contains an invalid secure-link connector image.');
    expect(source).toContain('RELAY_BUILD_VERSION="$manifest_version"');
    expect(source).toContain('RELAY_PROTOCOL_MAJOR="$protocol_major"');
    expect(source).toContain('minGatewayVersion');
    expect(source).toContain('requires Gateway');
    expect(source).toContain('or newer.');
    expect(source).toContain('GATEWAY_RELAY_IMAGE_REF');
    expect(source).toContain('gateway_relay_identity:/var/lib/gateway-relay/identity:ro');
    expect(source).toContain('gateway_relay_state:/var/lib/gateway-relay/state');
    expect(source).toContain('ensure_env GATEWAY_REGISTRY_IMAGE_REF "registry:3"');
    expect(source).toContain('ensure_env GATEWAY_REGISTRY_HTTP_SECRET "$(openssl rand -hex 32)"');
    expect(source).toContain('com.wiolett.gateway.managed-service: registry');
    expect(source).toContain('gateway_registry_data:/var/lib/registry');
    expect(source).toContain('      - "5000"');
    expect(source).not.toContain('      - "5000:5000"');
    expect(source).toContain('      - "9443:9443"');
    expect(source).toContain('Gateway recovery helper image pull');
    expect(source).toContain('--database-connector-image "$DATABASE_CONNECTOR_IMAGE_REF"');
    expect(source).toContain('--secure-link-connector-image "$SECURE_LINK_CONNECTOR_IMAGE_REF"');
    expect(source).toContain('compose pull app');
    expect(source).toContain('compose up -d --no-deps app');
    expect(source).toContain('ARTIFACT_KIND="local source checksum"');
    expect(source).toContain('short_digest "$ARTIFACT_DIGEST"');
  });

  it('publishes both connector images with Relay releases instead of Gateway releases', () => {
    const source = readFileSync(gitlabPipeline, 'utf8');
    const relaySigning = source.slice(source.indexOf('sign-relay-update:'), source.indexOf('upload-relay-update:'));
    const gatewaySigning = source.slice(
      source.indexOf('sign-gateway-update:'),
      source.indexOf('upload-gateway-update:')
    );
    const secureConnectorPublishing = source.slice(
      source.indexOf('publish-secure-link-connector:'),
      source.indexOf('\nrelease:')
    );
    const databaseConnectorPublishing = source.slice(
      source.indexOf('publish-database-connector:'),
      source.indexOf('publish-secure-link-connector:')
    );

    expect(relaySigning).toContain('publish-secure-link-connector');
    expect(relaySigning).toContain('publish-database-connector');
    expect(relaySigning).toContain('--secure-link-connector-image');
    expect(relaySigning).toContain('--database-connector-image');
    expect(relaySigning).toContain('--min-gateway-version');
    expect(relaySigning).toContain('config/relay/min-gateway-version');
    expect(gatewaySigning).not.toContain('publish-secure-link-connector');
    expect(gatewaySigning).not.toContain('publish-database-connector');
    expect(gatewaySigning).not.toContain('--secure-link-connector-image');
    expect(gatewaySigning).not.toContain('--database-connector-image');
    expect(secureConnectorPublishing).toContain('/^v\\d+\\.\\d+\\.\\d+-relay$/');
    expect(secureConnectorPublishing).not.toContain('/^v\\d+\\.\\d+\\.\\d+$/');
    expect(databaseConnectorPublishing).toContain('/^v\\d+\\.\\d+\\.\\d+-relay$/');
    expect(databaseConnectorPublishing).not.toContain('/^v\\d+\\.\\d+\\.\\d+$/');
    expect(readFileSync(relayMinGatewayVersion, 'utf8').trim()).toMatch(/^v\d+\.\d+\.\d+$/);
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
  it('creates the managed nginx layout when Alpine only provides http.d', () => {
    const source = readFileSync(nginxNodeInstaller, 'utf8');

    expect(source).toContain('mkdir -p /etc/nginx/conf.d');
    expect(source).toContain('backup_if_exists "/etc/nginx/http.d/default.conf"');
    expect(source).toContain("cat > /etc/nginx/conf.d/default.conf << 'EOF'");
  });

  it('keeps the shared Docker-node installer valid shell', () => {
    const syntax = spawnSync('bash', ['-n', dockerNodeInstaller], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('bootstraps Docker and Compose from Alpine packages before using OpenRC', () => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');

    expect(source).toContain('alpine) echo "alpine"');
    expect(source).toContain('install_system_packages docker docker-cli-compose');
    expect(source).toContain('Automatic Docker installation is supported only on Alpine/');
    expect(source).toContain('run_privileged_quiet rc-update add docker default');
    expect(source).toContain('run_privileged_quiet rc-service docker start');
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

  it('does not install the generic-workload Secure Runtime on database nodes', () => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');
    const setupStart = source.indexOf('setup_secure_runtime()');
    const setupEnd = source.indexOf('\n}\n', setupStart);
    const setup = source.slice(setupStart, setupEnd);

    expect(setup).toContain('[[ "$DOCKER_MODE" == "docker" ]] || return 0');
  });

  it('installs the builder profile without Docker Engine or Docker socket access', () => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');
    expect(source).toContain('docker|builder|databases');
    expect(source).toContain('[[ "$DOCKER_MODE" != "builder" ]] || return 0');
    expect(source).toContain('--mode builder');
    expect(source).toContain('grep -Eq \'^[[:space:]]+mode:[[:space:]]*"?builder"?[[:space:]]*$\'');
    expect(source).toContain('Builder profile must not contain Docker socket or allowlist access.');
    expect(source).toContain('[[ "$DOCKER_MODE" != "builder" ]] && docker_group_exists');
    expect(source).toContain('install_builder_runtime_bundle');
    expect(source).toContain('docker-builder-runtime-linux-' + '$' + '{ARCH}.tar.gz');
    expect(source).toContain('containerd-shim-runc-v2');
    expect(source).toContain('Builder runtime checksum verification failed.');
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

describe('node installer daemon downloads', () => {
  it.each([
    ['nginx', nginxNodeInstaller],
    ['docker', dockerNodeInstaller],
    ['monitoring', monitoringNodeInstaller],
  ])('%s searches enough GitLab releases to find less frequently published daemon tags', (_name, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('/releases?per_page=100');
  });

  it.each([
    ['nginx', nginxNodeInstaller, 'nginx-daemon'],
    ['docker', dockerNodeInstaller, 'docker-daemon'],
    ['monitoring', monitoringNodeInstaller, 'monitoring-daemon'],
  ])('%s fails closed when the requested daemon release cannot be downloaded', (_name, path, binary) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain(`die "Failed to download ${binary} \${RESOLVED_DAEMON_VERSION} from releases"`);
    expect(source).not.toContain(`Place the ${binary} binary at \${target}`);
  });
});

describe('daemon installer interactive selectors', () => {
  it.each([
    ['nginx', nginxNodeInstaller],
    ['docker', dockerNodeInstaller],
    ['monitoring', monitoringNodeInstaller],
    ['dispatcher', daemonInstaller],
  ])('%s falls back from arrow-key menus on serial consoles without leaking read errors', (_name, path) => {
    const source = readFileSync(path, 'utf8');
    const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(source).toContain('/dev/ttyS*|/dev/hvc*|/dev/xvc*|/dev/console');
    expect(source).toContain('read -rsn1 key < "$tty" 2>/dev/null');
  });
});

describe('nginx node path migration', () => {
  it('rewrites both quoted and legacy unquoted daemon config values', () => {
    const source = readFileSync(nginxNodeInstaller, 'utf8');

    expect(source).toContain('set_daemon_config_value htpasswd_dir "$NGINX_HTPASSWD_DIR"');
    expect(source).toContain('sed -i -E "s|^([[:space:]]*');
    expect(source).toContain(':[[:space:]]*).*$|');
    expect(source).not.toContain('s|htpasswd_dir: \\".*\\"|');
  });
});
