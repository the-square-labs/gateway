import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('install.sh ClickHouse ownership reconciliation', () => {
  it('disables managed internal-log cleanup when an existing installation uses remote ClickHouse', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-installer-'));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, '.env'),
      'CLICKHOUSE_URL=https://clickhouse.example.com\nCLICKHOUSE_MANAGED_INTERNAL_LOGS=true\n'
    );

    const result = spawnSync(
      'bash',
      [
        '-c',
        'GATEWAY_INSTALLER_LIBRARY_MODE=1; source "$1"; cd "$2"; LOGGING_MODE=remote; ensure_clickhouse_env',
        '_',
        installer,
        directory,
      ],
      { encoding: 'utf8' }
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(join(directory, '.env'), 'utf8')).toContain('CLICKHOUSE_MANAGED_INTERNAL_LOGS=false');
  });

  it('still executes when piped into bash stdin', () => {
    const result = spawnSync('bash', ['-s', '--', '--help'], {
      encoding: 'utf8',
      input: readFileSync(installer, 'utf8'),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Usage: install.sh [OPTIONS]');
  });
});
