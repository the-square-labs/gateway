import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors.js';
import { resolveCliPaths } from './paths.js';
import { normalizeGatewayOrigin, ProfileStore } from './profiles.js';

describe('Gateway profiles and paths', () => {
  it('normalizes safe origins and rejects path or insecure remote origins', () => {
    expect(normalizeGatewayOrigin('https://Gateway.Example.com:443/')).toBe('https://gateway.example.com');
    expect(normalizeGatewayOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(() => normalizeGatewayOrigin('http://gateway.example.com')).toThrow(CliError);
    expect(() => normalizeGatewayOrigin('https://gateway.example.com/admin')).toThrow(CliError);
    expect(() => normalizeGatewayOrigin('https://user:secret@gateway.example.com')).toThrow(CliError);
  });

  it('keeps installation IDs stable and isolates named profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-profile-'));
    const file = join(directory, 'profiles.json');
    const store = new ProfileStore(file, () => new Date('2026-07-28T12:00:00.000Z'));
    const first = await store.upsert('work', 'https://one.example.com', { clientId: 'client-1' });
    const second = await store.upsert('work', 'https://one.example.com', { clientId: 'client-2' });
    const other = await store.upsert('personal', 'https://two.example.com');

    expect(second.installationId).toBe(first.installationId);
    expect(second.clientId).toBe('client-2');
    expect(other.installationId).not.toBe(first.installationId);
    expect(await store.resolveName()).toBe('personal');
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('accessToken');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0);
  });

  it('uses platform application directories', () => {
    expect(resolveCliPaths({}, 'linux', '/home/alice').profilesFile).toBe(
      '/home/alice/.config/wiolett/gateway/profiles.json'
    );
    expect(resolveCliPaths({}, 'darwin', '/Users/alice').runtimeFile).toContain(
      '/Users/alice/Library/Application Support/Wiolett Gateway/runtime/gateway-cli.js'
    );
    expect(
      resolveCliPaths({ APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\alice').dataDir
    ).toContain('C:\\Local');
  });

  it('places all companion filesystem state under an explicit or environment home', () => {
    expect(resolveCliPaths({}, 'linux', '/home/alice', '/data/inference')).toEqual({
      configDir: '/data/inference',
      dataDir: '/data/inference',
      homeDir: '/data/inference',
      profilesFile: '/data/inference/profiles.json',
      fileCredentialsFile: '/data/inference/credentials.json',
      runtimeDir: '/data/inference/runtime',
      runtimeFile: '/data/inference/runtime/gateway-cli.js',
    });
    expect(resolveCliPaths({ GATEWAY_INFERENCE_HOME: '~/inference' }, 'linux', '/home/alice').homeDir).toBe(
      '/home/alice/inference'
    );
  });
});
