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
    expect(source).toContain('Use native HTTPS now?');
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
    expect(source).toContain('"${DOCKER[@]}" build');
    expect(source).toContain('--source-dir is supported only for a fresh Gateway installation');
  });

  it('does not advertise Docker or CNI interface addresses as host-local targets', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain('interface ~ /^docker/');
    expect(source).toContain('interface ~ /^br-/');
    expect(source).toContain('interface ~ /^veth/');
    expect(source).toContain('interface ~ /^cni/');
  });
});
