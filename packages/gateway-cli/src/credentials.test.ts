import { chmod, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CredentialBackend, FileCredentialBackend, SecureCredentialStore } from './credentials.js';
import { CliError } from './errors.js';
import type { OAuthCredential, RuntimeCredential } from './types.js';

const credential: OAuthCredential = {
  accessToken: 'gwo_access-secret',
  refreshToken: 'gwr_refresh-secret',
  tokenType: 'Bearer',
  scope: 'inference:setup',
};

class MemoryBackend implements CredentialBackend {
  readonly name = 'mock keyring';
  readonly values = new Map<string, string>();

  constructor(private readonly isAvailable: boolean) {}
  async available() {
    return this.isAvailable;
  }
  async get(account: string) {
    return this.values.get(account) ?? null;
  }
  async set(account: string, value: string) {
    this.values.set(account, value);
  }
  async delete(account: string) {
    this.values.delete(account);
  }
}

describe('secure credentials', () => {
  it('uses the platform backend without writing the fallback file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-credential-'));
    const backend = new MemoryBackend(true);
    const file = new FileCredentialBackend(join(directory, 'credentials.json'));
    const store = new SecureCredentialStore(backend, file);

    await store.set('work', credential);
    expect(await store.get('work')).toEqual(credential);
    expect(await file.exists()).toBe(false);
  });

  it('fails closed for a first non-interactive fallback without opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-credential-'));
    const store = new SecureCredentialStore(
      new MemoryBackend(false),
      new FileCredentialBackend(join(directory, 'credentials.json'))
    );
    await expect(store.set('work', credential)).rejects.toMatchObject({ code: 'SECURE_CREDENTIAL_STORE_UNAVAILABLE' });
  });

  it('writes an opted-in fallback with mode 0600 and reuses the accepted file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-credential-'));
    const path = join(directory, 'credentials.json');
    const file = new FileCredentialBackend(path);
    const store = new SecureCredentialStore(new MemoryBackend(false), file, { allowFileCredentials: true });
    await store.set('work', credential);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);

    const later = new SecureCredentialStore(new MemoryBackend(false), file);
    expect(await later.get('work')).toEqual(credential);
  });

  it('keeps OAuth and runtime tokens separate and reads an existing fallback when keyring is empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-credential-'));
    const file = new FileCredentialBackend(join(directory, 'credentials.json'));
    const fallback = new SecureCredentialStore(new MemoryBackend(false), file, { allowFileCredentials: true });
    const runtime: RuntimeCredential = {
      token: 'gwi_runtime-secret',
      tokenId: 'token-1',
      prefix: 'gwi_runtime',
      harness: 'codex',
      installationId: '33333333-3333-4333-8333-333333333333',
    };
    await fallback.set('work', credential);
    await fallback.setRuntime('work', runtime);

    const keyringAvailableButEmpty = new SecureCredentialStore(new MemoryBackend(true), file);
    expect(await keyringAvailableButEmpty.get('work')).toEqual(credential);
    expect(await keyringAvailableButEmpty.getRuntime('work')).toEqual(runtime);
    await keyringAvailableButEmpty.deleteRuntime('work');
    expect(await fallback.getRuntime('work')).toBeNull();
    expect(await fallback.get('work')).toEqual(credential);
  });

  it('rejects fallback files with group or world permissions', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-credential-'));
    const path = join(directory, 'credentials.json');
    const file = new FileCredentialBackend(path);
    await file.set('work', JSON.stringify(credential));
    await chmod(path, 0o644);
    await expect(file.get('work')).rejects.toBeInstanceOf(CliError);
  });
});
