import { join } from 'node:path';
import { runCli } from './cli.js';
import type { CliPaths } from './paths.js';

describe('Claude Code private credential helper', () => {
  it('prints only the dedicated Claude Code runtime token', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const credentials = {
      getRuntime: vi.fn(async (_profile: string, harness?: string) =>
        harness === 'claude-code'
          ? {
              token: 'gwi_claude-secret',
              tokenId: 'token-1',
              prefix: 'gwi_claude',
              harness: 'claude-code',
              installationId: '11111111-1111-4111-8111-111111111111',
            }
          : null
      ),
    };

    await expect(
      runCli(['__credential', 'claude-code'], {
        paths: paths('/tmp/gateway-cli-claude-test'),
        credentials: credentials as never,
        interactive: false,
      })
    ).resolves.toBe(0);

    expect(credentials.getRuntime).toHaveBeenCalledWith('default', 'claude-code');
    expect(write).toHaveBeenCalledWith('gwi_claude-secret\n');
    write.mockRestore();
  });
});

function paths(root: string): CliPaths {
  return {
    configDir: root,
    dataDir: root,
    profilesFile: join(root, 'profiles.json'),
    fileCredentialsFile: join(root, 'credentials.json'),
    runtimeDir: join(root, 'runtime'),
    runtimeFile: join(root, 'runtime', 'gateway-cli.js'),
  };
}
