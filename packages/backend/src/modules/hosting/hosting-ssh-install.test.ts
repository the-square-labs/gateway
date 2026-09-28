import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { parseNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import type { HostingOperationRow } from './hosting-operations.service.js';
import { type HostingResourceSnapshot, hostingCapabilities } from './hosting-provider.types.js';
import {
  createSshInstallKey,
  HostingSshInstaller,
  initialSshInstallState,
  installDiagnostics,
  rotateSshInstallToken,
  SSH_INSTALL_TOKEN_TTL_MS,
  type SshInstallState,
  sshInstallCommand,
} from './hosting-ssh-install.js';

const OPERATION = '33333333-3333-4333-8333-333333333333';
const MARKER = `gw-${OPERATION}`;
const PIN = 'SHA256:pinnedHostKeyFingerprint';
const key = createSshInstallKey(MARKER);
const resource: HostingResourceSnapshot = {
  remoteId: '0a1b2c3d-1111-4222-8333-444455556666',
  kind: 'vm',
  name: 'web-1',
  location: '1',
  powerState: 'running',
  cpu: 2,
  memoryMb: 4096,
  diskGb: 80,
  addresses: [
    { ip: '2001:db8::20', network: 'public', direct: true },
    { ip: '203.0.113.20', network: 'public', direct: true },
  ],
  incarnation: 'uuid:0a1b2c3d-1111-4222-8333-444455556666',
  capabilities: hostingCapabilities({ start: true }),
  observedAt: '2026-09-28T00:00:00Z',
};
type Exec = {
  address: string;
  username: string;
  privateKey: string;
  hostFingerprint: string;
  prepare: () => Promise<string>;
};

function setup(options: { exitCode?: number; stdout?: string; release?: () => Promise<{ deleted: number }> } = {}) {
  let row = {
    id: OPERATION,
    actorId: 'actor',
    nodeId: 'node',
    resourceId: 'resource',
    action: 'create',
    phase: 'provisioning',
    dispatchStartedAt: null,
    encryptedBootstrap: '{}',
    result: { sshInstall: initialSshInstallState() },
  } as unknown as HostingOperationRow;
  const commands: string[] = [];
  const operations = {
    update: vi.fn(async (_row: HostingOperationRow, patch: Partial<HostingOperationRow>) => {
      row = { ...row, ...patch };
      return row;
    }),
    dispatch: vi.fn(async (_row: HostingOperationRow, phase: HostingOperationRow['phase']) => {
      if (row.dispatchStartedAt) throw new AppError(409, 'HOSTING_DISPATCH_ALREADY_STARTED', 'fenced');
      row = { ...row, phase, dispatchStartedAt: new Date() };
      return row;
    }),
    finish: vi.fn(async (_row: HostingOperationRow, phase: 'ready' | 'failed', result?: object, error?: object) => {
      row = { ...row, phase, encryptedBootstrap: null, result: { ...row.result, ...result }, ...error };
      return row;
    }),
  };
  const ssh = {
    readHostKeyForHosting: vi.fn(async () => PIN),
    executeWithKeyForHosting: vi.fn(async (input: Exec) => {
      const command = await input.prepare();
      commands.push(command);
      return {
        exitCode: options.exitCode ?? 0,
        stdout: options.stdout ?? 'installed\nGATEWAY_INSTALL_KEY_REMOVED\n',
        sent: true as const,
      };
    }),
  };
  const audit = { log: vi.fn(async (_entry: { action: string }) => true) };
  const adapter = { releaseInstallKey: vi.fn(options.release ?? (async () => ({ deleted: 1 }))) };
  const installer = new HostingSshInstaller({ operations, ssh: ssh as never, audit });
  const script = vi.fn(async () => '#!/bin/bash\necho install --token gw_node_secret');
  return {
    installer,
    operations,
    ssh,
    audit,
    adapter,
    script,
    commands,
    row: () => row,
    state: () => row.result?.sshInstall as SshInstallState,
    install: () => installer.install(row, resource, key, script, adapter as never),
  };
}

describe('HostingSshInstaller', () => {
  it('pins the host key, installs as root once and removes the one-time key everywhere', async () => {
    const test = setup();
    await test.install();
    expect(test.ssh.readHostKeyForHosting).toHaveBeenCalledOnce();
    expect(test.ssh.readHostKeyForHosting).toHaveBeenCalledWith('203.0.113.20');
    const call = test.ssh.executeWithKeyForHosting.mock.calls[0]![0];
    expect(call).toMatchObject({ address: '203.0.113.20', username: 'root', hostFingerprint: PIN });
    expect(call.privateKey).toBe(key.privateKey);
    expect(test.operations.dispatch).toHaveBeenCalledWith(expect.anything(), 'installing');
    // The installer travels base64-encoded and its key is removed only after a successful run.
    expect(test.commands[0]).toContain(Buffer.from(await test.script(), 'utf8').toString('base64'));
    expect(test.commands[0]).toContain(key.publicKey.split(' ')[1]);
    expect(test.commands[0]).not.toContain('gw_node_secret');
    expect(test.adapter.releaseInstallKey).toHaveBeenCalledWith(MARKER);
    expect(test.row()).toMatchObject({ phase: 'installing', dispatchStartedAt: null });
    expect(test.state()).toMatchObject({
      address: '203.0.113.20',
      hostFingerprint: PIN,
      exitCode: 0,
      guestKey: 'removed',
      providerKey: 'deleted',
      providerKeyAttempts: 1,
    });
    expect(test.audit.log.mock.calls.map(([entry]) => entry.action)).toEqual([
      'hosting.install.ssh_host_key_pinned',
      'hosting.install.ssh_dispatched',
      'hosting.install.ssh_completed',
      'hosting.install.ssh_key_released',
    ]);
    expect(JSON.stringify(test.row().result)).not.toContain('PRIVATE KEY');
  });

  it('still deletes the provider key when installation fails and keeps the guest key', async () => {
    const test = setup({ exitCode: 3, stdout: 'failed' });
    await test.install();
    expect(test.adapter.releaseInstallKey).toHaveBeenCalledWith(MARKER);
    expect(test.operations.finish).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      undefined,
      expect.objectContaining({ code: 'HOSTING_INSTALL_FAILED' })
    );
    expect(test.state()).toMatchObject({
      exitCode: 3,
      guestKey: 'retained',
      providerKey: 'deleted',
      diagnostics: 'failed',
    });
    expect(test.operations.finish).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      undefined,
      expect.objectContaining({ message: expect.stringContaining('exited with code 3: failed') })
    );
    expect(test.commands[0]).toContain('if [ "$status" -eq 0 ]; then');
  });

  it('keeps the tail of a failed installer output without colours or enrollment tokens', () => {
    const token = 'gw_node_v2_0123abcd_89efcdef0123';
    const diagnostics = installDiagnostics({
      stdout: `${'x'.repeat(5000)}\n\u001b[32m✓\u001b[0m Docker ready\nEnrolling with --token ${token}`,
      stderr: `\u001b[31mError:\u001b[0m enrollment refused for ${token}`,
    });
    expect(diagnostics.length).toBeLessThanOrEqual(4000);
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain('\u001b');
    expect(diagnostics).toContain('✓ Docker ready');
    expect(diagnostics.endsWith('Error: enrollment refused for gw_node_[redacted]')).toBe(true);
  });

  it('defers the terminal outcome and retries a failed provider key cleanup', async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new AppError(502, 'HOSTING_PROVIDER_ERROR', 'CloudBlast unavailable'))
      .mockResolvedValue({ deleted: 1 });
    const test = setup({ exitCode: 1, release });
    await test.install();
    expect(test.operations.finish).not.toHaveBeenCalled();
    expect(test.row()).toMatchObject({
      phase: 'unknown',
      encryptedBootstrap: null,
      errorCode: 'HOSTING_SSH_KEY_CLEANUP_PENDING',
    });
    expect(test.state()).toMatchObject({ providerKey: 'failed', providerKeyAttempts: 1 });
    const resumed = await test.installer.resume(test.row(), test.adapter as never, () => undefined);
    expect(resumed.done).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    expect(test.operations.finish).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      expect.objectContaining({
        sshInstall: expect.objectContaining({ providerKey: 'deleted', providerKeyAttempts: 2 }),
      }),
      expect.objectContaining({ code: 'HOSTING_INSTALL_FAILED' })
    );
  });

  it('retries a failed cleanup after a successful installation on the next tick', async () => {
    const release = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ deleted: 1 });
    const test = setup({ release });
    await test.install();
    expect(test.row().phase).toBe('installing');
    expect(test.state().providerKey).toBe('failed');
    const resumed = await test.installer.resume(test.row(), test.adapter as never, () => key);
    expect(resumed.done).toBe(false);
    expect(test.state()).toMatchObject({ providerKey: 'deleted', providerKeyAttempts: 2 });
  });

  it('trusts the host key once and pins it across reconnects within the operation', async () => {
    const test = setup({ stdout: 'installed without sentinel' });
    test.ssh.executeWithKeyForHosting.mockRejectedValueOnce(
      Object.assign(new AppError(502, 'SSH_CONNECTION_FAILED', 'not ready'), { sent: false })
    );
    await test.install();
    expect(test.row()).toMatchObject({ phase: 'provisioning', errorCode: 'HOSTING_SSH_INSTALL_WAITING' });
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.script).not.toHaveBeenCalled();
    await test.install();
    // The guest key removal reconnect uses the same pin and never probes again.
    expect(test.ssh.readHostKeyForHosting).toHaveBeenCalledOnce();
    expect(test.ssh.executeWithKeyForHosting).toHaveBeenCalledTimes(3);
    for (const [call] of test.ssh.executeWithKeyForHosting.mock.calls) expect((call as Exec).hostFingerprint).toBe(PIN);
    expect(test.state()).toMatchObject({ guestKey: 'failed', guestKeyAttempts: 2 });
  });

  it('refuses a changed host key or address without sending the installer', async () => {
    const test = setup();
    test.ssh.executeWithKeyForHosting.mockRejectedValueOnce(
      Object.assign(new AppError(409, 'HOSTING_SSH_HOST_KEY_MISMATCH', 'changed'), { sent: false })
    );
    await expect(test.install()).rejects.toMatchObject({ code: 'HOSTING_SSH_HOST_KEY_MISMATCH' });
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    const moved = { ...resource, addresses: [{ ip: '198.51.100.9', network: 'public', direct: true }] };
    await expect(
      test.installer.install(test.row(), moved, key, test.script, test.adapter as never)
    ).rejects.toMatchObject({ code: 'HOSTING_SSH_TARGET_CHANGED' });
  });
});

describe('SSH install enrollment token', () => {
  it('rotates to a single-use token that expires after 30 minutes', async () => {
    let change: Record<string, unknown> = {};
    let rows: Array<{ id: string }> = [{ id: 'node' }];
    const db = {
      update: () => ({
        set: (value: Record<string, unknown>) => {
          change = value;
          return { where: () => ({ returning: async () => rows }) };
        },
      }),
    };
    const before = Date.now();
    const token = await rotateSshInstallToken(db as never, 'node');
    const parsed = parseNodeEnrollmentToken(token);
    expect(parsed.kind).toBe('v2');
    expect(change.enrollmentTokenSelector).toBe(parsed.kind === 'v2' ? parsed.selector : null);
    await expect(bcrypt.compare(token, String(change.enrollmentTokenHash))).resolves.toBe(true);
    const expiresAt = (change.enrollmentTokenExpiresAt as Date).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(SSH_INSTALL_TOKEN_TTL_MS);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(SSH_INSTALL_TOKEN_TTL_MS);
    expect(SSH_INSTALL_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    // Enrollment clears the hash; an enrolled node never receives another token.
    rows = [];
    await expect(rotateSshInstallToken(db as never, 'node')).rejects.toMatchObject({
      code: 'HOSTING_NODE_ALREADY_ENROLLED',
    });
  });

  it('keeps the token-bearing installer in a private temp file removed after the run', () => {
    const command = sshInstallCommand('echo --token gw_node_secret', key.publicKey);
    expect(command.startsWith('umask 077\n')).toBe(true);
    expect(command).toContain('bash "$script"');
    expect(command).toContain('rm -f "$script"');
    expect(command).not.toContain('gw_node_secret');
    expect(key.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(key.privateKey).toContain('PRIVATE KEY');
  });
});
