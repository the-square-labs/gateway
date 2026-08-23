import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeLegacyCodexUsageComponents } from './codex-usage-cleanup.js';
import { resolveCliPaths } from './paths.js';

const MARKER = 'wiolett-gateway-codex-usage-v1';

describe('legacy Codex usage cleanup', () => {
  it('removes owned macOS wrappers and clears their launchctl activation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gateway-usage-cleanup-'));
    const paths = resolveCliPaths({}, 'darwin', home);
    const wrapper = join(paths.runtimeDir, 'codex-desktop-wrapper');
    const launcher = join(home, '.local', 'bin', 'gateway-codex');
    const agent = join(home, 'Library', 'LaunchAgents', 'net.wiolett.gateway.codex-usage.plist');
    await Promise.all([
      mkdir(paths.runtimeDir, { recursive: true }),
      mkdir(join(home, '.local', 'bin'), { recursive: true }),
      mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(wrapper, `#!/bin/sh\n# ${MARKER}\n`),
      writeFile(launcher, `#!/bin/sh\n# ${MARKER}\n`),
      writeFile(agent, `<!-- ${MARKER} -->\n`),
      writeFile(join(paths.dataDir, 'codex-usage.json'), '{}'),
    ]);
    let launchValue = wrapper;
    const commandRunner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'getenv') return { code: 0, stdout: launchValue, stderr: '' };
      if (args[0] === 'unsetenv') launchValue = '';
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await removeLegacyCodexUsageComponents(paths, {
      platform: 'darwin',
      home,
      commandRunner,
    });

    expect(result).toMatchObject({ desktop: true, cli: true });
    expect(launchValue).toBe('');
    await expect(access(wrapper)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(launcher)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(agent)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.dataDir, 'codex-usage.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves foreign files at legacy launcher paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gateway-usage-cleanup-'));
    const paths = resolveCliPaths({}, 'linux', home);
    const launcher = join(home, '.local', 'bin', 'gateway-codex');
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(launcher, '#!/bin/sh\necho foreign\n');

    await removeLegacyCodexUsageComponents(paths, { platform: 'linux', home });

    await expect(readFile(launcher, 'utf8')).resolves.toContain('foreign');
  });
});
