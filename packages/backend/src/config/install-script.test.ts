import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const installer = fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url));
const githubReleaseScript = fileURLToPath(new URL('../../../../scripts/github-release.sh', import.meta.url));
const relayMinGatewayVersion = fileURLToPath(new URL('../../../../config/relay/min-gateway-version', import.meta.url));
const nginxNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-node.sh', import.meta.url));
const dockerNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-docker-node.sh', import.meta.url));
const monitoringNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-monitoring-node.sh', import.meta.url));
const daemonInstaller = fileURLToPath(new URL('../../../../scripts/setup-daemon.sh', import.meta.url));
const releaseWorkflow = fileURLToPath(new URL('../../../../.github/workflows/release.yml', import.meta.url));
const relayNodeInstaller = fileURLToPath(new URL('../../../../scripts/setup-relay-node.sh', import.meta.url));

describe('nginx node installer baseline', () => {
  it('configures production-safe worker and version-token defaults', () => {
    const source = readFileSync(nginxNodeInstaller, 'utf8');

    expect(source).toContain('NGINX_WORKER_NOFILE_MIN=65535');
    expect(source).toContain('NGINX_SERVICE_NOFILE_MIN=65536');
    expect(source).toContain('NGINX_WORKER_CONNECTIONS_MIN=8192');
    expect(source).toContain('worker_rlimit_nofile 65535;');
    expect(source).toContain('worker_connections 8192;');
    expect(source).toContain('server_tokens off;');
    expect(source).toContain('LimitNOFILE=$' + '{NGINX_SERVICE_NOFILE_MIN}');
    expect(source).toContain('rc_ulimit="$' + '{rc_ulimit:-} -n %s"');
    expect(source).toContain('Effective nginx server_tokens must be off');
    expect(source.indexOf('nginx_version() {')).toBeLessThan(source.indexOf('dry_run_preview() {'));
    expect(source).toContain('remove_legacy_gateway_sites_include');
    expect(source).toContain('[[ "$effective_content" == "$expected_line" ]] || return 0');
    expect(source).toContain('backup_if_exists "$legacy_file"');
    expect(source).toContain('if [[ "$NGINX_SERVICE_RESTART_REQUIRED" -eq 1 ]] || nginx_worker_requires_restart; then');
    expect(source).toContain(`child_args=$(tr '\\0' ' ' < "/proc/\${child_pid}/cmdline")`);
    expect(source).toContain('Running nginx worker process still has a nofile limit below');
    expect(source).not.toContain('Running nginx master process still has a nofile limit below');
    expect(source).toContain('run_apt_with_lock_retry()');
    expect(source).toContain('Unable to acquire the dpkg frontend lock');
    expect(source).toContain('run_apt_with_lock_retry install -y -qq gnupg2 ca-certificates lsb-release');
    expect(source).toContain('run_apt_with_lock_retry install -y -qq nginx');
    expect(source).toContain('if ! systemctl is-active --quiet nginx; then');
    expect(source).toContain('systemctl start nginx >> "$LOG_FILE" 2>&1 || die "Failed to start nginx"');
    const configTest = source.indexOf('if nginx -t >> "$LOG_FILE" 2>&1; then');
    const tokenCheck = source.indexOf('verify_nginx_server_tokens', configTest);
    const serviceStart = source.indexOf('systemctl start nginx', tokenCheck);
    const serviceAction = source.indexOf('systemctl restart nginx', tokenCheck);
    expect(configTest).toBeGreaterThanOrEqual(0);
    expect(tokenCheck).toBeGreaterThan(configTest);
    expect(serviceStart).toBeGreaterThan(tokenCheck);
    expect(serviceAction).toBeGreaterThan(tokenCheck);
  });

  it('retries apt lock contention without retrying unrelated package errors', () => {
    const source = readFileSync(nginxNodeInstaller, 'utf8');
    const helperStart = source.indexOf('run_apt_with_lock_retry() {');
    const helperEnd = source.indexOf('\ninstall_nginx_stable_repo() {', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const testDir = mkdtempSync(join(tmpdir(), 'gateway-node-apt-retry-'));
    const binDir = join(testDir, 'bin');
    const runner = join(testDir, 'runner.sh');
    const fakeApt = join(binDir, 'apt-get');
    const attempts = join(testDir, 'attempts');
    const logFile = join(testDir, 'installer.log');

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    mkdirSync(binDir);
    writeFileSync(
      fakeApt,
      `#!/usr/bin/env bash
count=0
[[ ! -f "$FAKE_APT_ATTEMPTS" ]] || count=$(cat "$FAKE_APT_ATTEMPTS")
count=$((count + 1))
printf '%s' "$count" > "$FAKE_APT_ATTEMPTS"
if [[ "$FAKE_APT_MODE" == "lock-once" && "$count" -eq 1 ]]; then
  echo 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 123 (apt-get)'
  exit 100
fi
if [[ "$FAKE_APT_MODE" == "failure" ]]; then
  echo 'E: repository unavailable'
  exit 42
fi
echo 'package operation complete'
`
    );
    chmodSync(fakeApt, 0o755);
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
set -euo pipefail
PATH="${binDir}:$PATH"
LOG_FILE="${logFile}"
APT_LOCK_RETRY_ATTEMPTS=3
APT_LOCK_RETRY_DELAY_SECONDS=0
warn() { :; }
die() { return 1; }
${helper}
run_apt_with_lock_retry update -qq
`
    );

    const lockRetry = spawnSync('bash', [runner], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_APT_ATTEMPTS: attempts, FAKE_APT_MODE: 'lock-once' },
    });
    expect(lockRetry.status, lockRetry.stderr).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('2');
    expect(readFileSync(logFile, 'utf8')).toContain('Could not get lock');

    writeFileSync(attempts, '0');
    const unrelatedFailure = spawnSync('bash', [runner], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_APT_ATTEMPTS: attempts, FAKE_APT_MODE: 'failure' },
    });
    expect(unrelatedFailure.status).toBe(42);
    expect(readFileSync(attempts, 'utf8')).toBe('1');
  });
});

describe('setup-relay-node.sh', () => {
  it('verifies separately scoped artifacts and registers the immutable launcher', () => {
    const syntax = spawnSync('bash', ['-n', relayNodeInstaller], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const source = readFileSync(relayNodeInstaller, 'utf8');
    expect(source).toContain('fetch_verified "$SUPERVISOR" relay');
    expect(source).toContain('fetch_verified "$WORKER" relay-worker');
    expect(source).toContain('openssl pkeyutl -verify');
    expect(source).toContain('run-supervisor');
    expect(source).toContain('exec /usr/local/bin/relay-supervisor run "$@"');
    expect(source).toContain('.update-pending');
    expect(source).not.toContain('mv -f "$previous" "$binary"');
    expect(source).toContain('ExecStart=/usr/local/lib/gateway-relay/run-supervisor');
    expect(source).toContain(`local name="$1" daemon_type="$2"\n  local manifest="\${TEMP_DIR}/\${name}.update.json"`);
    expect(source).not.toContain(`local name="$1" daemon_type="$2" manifest="\${TEMP_DIR}/\${name}.update.json"`);
  });
});

describe('immutable launcher service registration fallback', () => {
  it.each([
    ['docker', dockerNodeInstaller, '/usr/local/bin/docker-daemon', '/var/lib/docker-daemon', 'docker-daemon'],
    ['nginx', nginxNodeInstaller, '/usr/local/bin/nginx-daemon', '/var/lib/nginx-daemon', 'nginx-daemon'],
    [
      'monitoring',
      monitoringNodeInstaller,
      '/usr/local/bin/monitoring-daemon',
      '/var/lib/monitoring-daemon',
      'monitoring-daemon',
    ],
    [
      'relay',
      relayNodeInstaller,
      '/usr/local/bin/relay-supervisor',
      '/var/lib/gateway-relay-supervisor',
      'gateway-relay-supervisor',
    ],
  ])('%s retains a verified manual fallback contract', (_name, path, binary, stateDir, unit) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('manual_launcher_fallback()');
    expect(source).toContain(`manual_launcher_fallback`);
    expect(source).toContain(binary);
    expect(source).toContain(stateDir);
    expect(source).toContain('owner.json');
    expect(source).toContain('child.json');
    expect(source).toContain('"protocolVersion"[[:space:]]*:[[:space:]]*1');
    expect(source).toContain('daemonType');
    expect(source).toContain('manual.log');
    expect(source).toContain('kill -0');
    expect(source).toContain('"ready"[[:space:]]*:[[:space:]]*true');
    expect(source).toContain('nohup');
    expect(source).toContain('setsid');
    expect(source).toContain('RUN_USER');
    expect(source).toContain('RUN_GROUP');
    expect(source).toContain('Manual mode is not persistent across reboot.');
    expect(source).toContain('Foreground command:');
    expect(source).toContain(`/etc/systemd/system/\${unit}.service.d/20-update-rollback.conf`);
    expect(source).toContain(unit);
    expect(source).toContain('update-guard');
    expect(source).toContain('.update-state.json');
    expect(source).toContain('.update-pending');
    expect(source).toContain('.update-outcome.json');
    expect(source).toContain('preserved .previous and unknown files');
    expect(source).toContain('if ! systemctl daemon-reload');
    expect(source).toContain('command_exists systemctl && [[ -d /run/systemd/system ]]');
  });

  it('keeps OpenRC fallback coverage on every daemon installer', () => {
    for (const path of [nginxNodeInstaller, dockerNodeInstaller, monitoringNodeInstaller, relayNodeInstaller]) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('rc-service');
      expect(source).toContain('manual_launcher_fallback');
    }
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
    expect(source).not.toContain('databaseConnectorImage');
    expect(source).not.toContain('DATABASE_CONNECTOR_IMAGE');
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
    expect(source).toContain(
      'RELEASES_API_URL="$' + '{RELEASES_API_URL:-https://updates.thesqlabs.com/gateway/releases}"'
    );
    expect(source).toContain('ARTIFACT_BASE_URL="$' + '{ARTIFACT_BASE_URL:-https://updates.thesqlabs.com/gateway}"');
    expect(source).toContain('DEFAULT_IMAGE="ghcr.io/the-square-labs/gateway"');
    expect(source).toContain('download_release_artifact gateway "$version" gateway-image.update.json');
    expect(source).toContain('download_release_artifact relay "$relay_tag" relay-image.update.json');
    expect(source).not.toContain('GitLab compatibility source');
    expect(source).toContain('ensure_env GATEWAY_REGISTRY_HTTP_SECRET "$(openssl rand -hex 32)"');
    expect(source).toContain('com.wiolett.gateway.managed-service: registry');
    expect(source).toContain('gateway_registry_data:/var/lib/registry');
    expect(source).toContain('      - "5000"');
    expect(source).not.toContain('      - "5000:5000"');
    expect(source).toContain('      - "9443:9443"');
    expect(source).toContain('Gateway recovery helper image pull');
    expect(source).toContain('--secure-link-connector-image "$SECURE_LINK_CONNECTOR_IMAGE_REF"');
    expect(source).toContain('compose pull app');
    expect(source).toContain('compose up -d --no-deps app');
    expect(source).toContain('ARTIFACT_KIND="local source checksum"');
    expect(source).toContain('short_digest "$ARTIFACT_DIGEST"');
  });

  it('publishes only the node-level Secure Link connector with Relay releases', () => {
    const source = readFileSync(githubReleaseScript, 'utf8');
    const relayPublishing = source.slice(source.indexOf('publish_relay()'), source.indexOf('\nif [[ "$RELEASE_KIND"'));
    const gatewayPublishing = source.slice(source.indexOf('publish_gateway()'), source.indexOf('\npublish_daemon()'));

    expect(relayPublishing).not.toContain('database-connector');
    expect(relayPublishing).toContain('secure-link-connector');
    expect(relayPublishing).toContain('--secure-link-connector-image');
    expect(relayPublishing).toContain('--min-gateway-version');
    expect(relayPublishing).toContain('config/relay/min-gateway-version');
    expect(gatewayPublishing).not.toContain('--secure-link-connector-image');
    expect(gatewayPublishing).not.toContain('--database-connector-image');
    expect(source).toContain('source scripts/release-tag.sh');
    expect(source).toContain('[[ "$RELEASE_COMPONENT" == "relay" ]]');
    expect(source).not.toContain('[[ "$RELEASE_COMPONENT" == "database-connector" ]]');
    expect(source).not.toContain('[[ "$RELEASE_COMPONENT" == "secure-link-connector" ]]');
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
    expect(source).toContain('install_builder_runtime');
    expect(source).toContain('github.com/containerd/containerd/releases/download');
    expect(source).toContain('github.com/moby/buildkit/releases/download');
    expect(source).toContain('github.com/opencontainers/runc/releases/download');
    expect(source).toContain('chmod 0755 "$staging_dir/bin/runc"');
    expect(source).toContain('github.com/anchore/syft/releases/download');
    expect(source).toContain('github.com/anchore/grype/releases/download');
    expect(source).toContain('containerd-shim-runc-v2');
    expect(source).toContain('BUILDER_RUNTIME_BIN_DIR="$' + '{BUILDER_RUNTIME_ROOT}/bin"');
    expect(source).toContain('"format=3"');
    expect(source).toContain('"bin_dir=$' + '{BUILDER_RUNTIME_BIN_DIR}"');
    expect(source).toContain(
      'install -m 0755 "$' + '{staging_dir}/bin/$' + '{binary}" "$' + '{BUILDER_RUNTIME_BIN_DIR}/$' + '{binary}"'
    );
    expect(source).toContain('service_environment="Environment=\\"PATH=$' + '{BUILDER_RUNTIME_PATH}\\""');
    expect(source).toContain('Moved legacy Gateway builder binary');
    expect(source).toContain('quarantine_legacy_builder_runtime_conflicts');
    expect(source).toContain('Moved a legacy Gateway builder runtime out of /usr/local/bin');
    expect(source).toContain('"$legacy_containerd" --version');
    expect(source).toContain('"$legacy_shim" -v');
    expect(source).toContain('"$legacy_runc" --version');
    expect(source).not.toContain(
      'install -m 0755 "$' + '{staging_dir}/bin/$' + '{binary}" "/usr/local/bin/$' + '{binary}"'
    );
    expect(source).toContain('Checksum verification failed for $' + '{label}.');
    expect(source).not.toContain('docker-builder-runtime-linux-');
  });

  it.each([
    ['fresh config', 'docker:\n  mode: "builder"\n'],
    ['v2.9.6 malformed config', 'docker:\nbuilder:\n    egress_profile: "internet"\n  mode: "builder"\n'],
  ])('writes a valid canonical builder profile from %s', (_name, dockerSection) => {
    const source = readFileSync(dockerNodeInstaller, 'utf8');
    const start = source.indexOf('write_builder_profile_config() {');
    const end = source.indexOf('\n}\n', start) + 3;
    const fn = source.slice(start, end);
    const directory = mkdtempSync(join(tmpdir(), 'gateway-builder-profile-'));
    const configPath = join(directory, 'config.yaml');
    writeFileSync(configPath, `gateway:\n  address: gateway.example:9443\n${dockerSection}`, 'utf8');

    const result = spawnSync(
      'bash',
      [
        '-c',
        `${fn}\ndie() { printf '%s\\n' "$*" >&2; return 1; }\nok() { :; }\nwrite_builder_profile_config "$1"`,
        'test',
        configPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DOCKER_MODE: 'builder',
          RUN_USER: 'root',
          BUILDER_EGRESS_PROFILE: 'internet',
        },
      }
    );

    expect(result.status, result.stderr).toBe(0);
    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      docker: { mode: string; builder: { egress_profile: string } };
    };
    expect(parsed.docker).toEqual({ mode: 'builder', builder: { egress_profile: 'internet' } });
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
  ])('%s uses the shared Gateway release feed for daemon tags', (_name, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('https://updates.thesqlabs.com/gateway/releases');
    expect(source).toContain('https://updates.thesqlabs.com/gateway');
    expect(source).not.toContain('gitlab.wiolett.net');
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

describe('daemon installer release integrity', () => {
  it('downloads immutable release assets and verifies the selected installer checksum', () => {
    const source = readFileSync(daemonInstaller, 'utf8');
    const workflow = readFileSync(releaseWorkflow, 'utf8');

    expect(source).toContain('gateway-daemon-installers.sha256');
    expect(source).toContain('Checksum verification failed for $' + '{name}');
    expect(source).toContain('/download/$' + '{SETUP_VERSION}');
    expect(source).not.toContain('raw.githubusercontent.com');
    expect(workflow).toContain('gateway-daemon-installers.sha256');
    expect(workflow).toContain('scripts/setup-daemon.sh');
    expect(workflow).toContain('scripts/setup-database-node.sh');
  });

  it('fails the release gate when the tagged commit has no successful main CI instead of verifying twice', () => {
    const workflow = readFileSync(releaseWorkflow, 'utf8');
    const verifyJob = workflow.slice(workflow.indexOf('  verify:'), workflow.indexOf('\n  build:'));

    expect(verifyJob).toContain('name: Require successful main CI');
    expect(verifyJob).toContain('timeout-minutes: 5');
    expect(verifyJob).toContain('head_branch == "main" and .conclusion == "success"');
    expect(verifyJob).toContain('refusing to run duplicate release verification');
    expect(verifyJob).toContain('exit 1');
    expect(verifyJob).not.toContain('- name: Install pnpm');
    expect(verifyJob).not.toContain('run: pnpm lint');
    expect(verifyJob).not.toContain('run: pnpm typecheck');
    expect(verifyJob).not.toContain('run: pnpm test');
    expect(verifyJob).not.toContain('run: pnpm build:all');
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
