import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url));

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
