import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../../../scripts/', import.meta.url));

describe('unified Storage installer entry points', () => {
  it.each(['storage', 'databases'])('dispatches %s locally without installing anything', (type) => {
    const scratch = mkdtempSync(join(tmpdir(), 'gateway-installer-test-'));
    try {
      writeFileSync(join(scratch, 'setup-storage-node.sh'), readFileSync(join(scripts, 'setup-storage-node.sh')));
      writeFileSync(
        join(scratch, 'setup-database-node.sh'),
        `printf "profile=%s\\n" "\${GATEWAY_DOCKER_MODE:-databases}"\nprintf "arg=%s\\n" "$@"\n`
      );
      const output = execFileSync(
        'bash',
        [join(scripts, 'setup-daemon.sh'), '--type', type, '--script-dir', scratch, '--name', 'Storage with spaces'],
        {
          encoding: 'utf8',
          env: { ...process.env, GATEWAY_DOCKER_MODE: '' },
          timeout: 5000,
        }
      );
      expect(output).toContain(`profile=${type}`);
      expect(output).toContain('arg=Storage with spaces');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('includes the Storage wrapper in the component release installer inventory and checksums', () => {
    const release = readFileSync(join(scripts, 'github-release.sh'), 'utf8');
    expect(release).toContain('scripts/setup-storage-node.sh');
    expect(release).toMatch(/sha256sum[^\n]+setup-storage-node\.sh[^\n]+gateway-daemon-installers\.sha256/);
  });
});
