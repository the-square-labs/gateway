import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SandboxRunnerJobPolicy } from './ai.sandbox-runner.protocol.js';
import { AISandboxRunnerService } from './ai.sandbox-runner.service.js';

function dockerAvailable(): boolean {
  try {
    if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) return false;
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    execFileSync('docker', ['image', 'inspect', 'alpine:3.20'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeIfDocker = dockerAvailable() ? describe : describe.skip;

describe('AISandboxRunnerService shutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('kills only the runner process when its bounded IPC shutdown stalls', async () => {
    vi.useFakeTimers();
    const runner = new AISandboxRunnerService('/tmp/gateway-sandbox-runner-shutdown-test.sock');
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    (runner as any).child = child;
    (runner as any).statusValue = 'running';

    const stopping = runner.stop(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    await stopping;

    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    await expect(runner.ensureStarted()).rejects.toThrow('Sandbox runner is shutting down');
  });

  it('cannot start after shutdown even when no runner process existed', async () => {
    const runner = new AISandboxRunnerService('/tmp/gateway-sandbox-runner-never-started-test.sock');

    await runner.stop();

    await expect(runner.ensureStarted()).rejects.toThrow('Sandbox runner is shutting down');
  });
});

describeIfDocker('AISandboxRunnerService docker smoke', () => {
  let tempDir = '';
  let runner: AISandboxRunnerService | null = null;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-sandbox-runner-test-'));
  });

  afterEach(async () => {
    await runner?.stop().catch(() => {});
    runner = null;
    cleanupTestContainers();
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('runs through the unix socket, keeps containers offline, and moves artifacts without chat base64', async () => {
    const socketPath = path.join(tempDir, 'runner.sock');
    runner = new AISandboxRunnerService(socketPath);

    const policy = makePolicy('script-smoke', 'script', 30);
    const scriptResult = await runner.executeScript({
      policy,
      script: [
        'echo hello-sandbox',
        'echo file-content > result.txt',
        'wget -qO- https://example.com >/tmp/network.out 2>/tmp/network.err && exit 42 || true',
      ].join('\n'),
    });

    expect(scriptResult.exitCode).toBe(0);
    expect(scriptResult.output).toContain('hello-sandbox');

    const processResult = await runner.runProcess({
      policy: makePolicy('process-smoke', 'process', 30),
      command: ['sh', '-lc', 'echo process-ready | tee result.txt; sleep 20'],
    });
    const readyOutput = await waitForOutput(runner, processResult.processId, 'process-ready');
    expect(readyOutput.output).toContain('process-ready');

    const readResult = await runner.readArtifact({
      processId: processResult.processId,
      path: 'result.txt',
      encoding: 'utf8',
    });
    expect(readResult.content).toBe('process-ready\n');
    expect(readResult.contentBase64).toBeUndefined();

    await runner.uploadArtifactChunk({
      processId: processResult.processId,
      path: 'streamed.bin',
      offset: 0,
      contentBase64: Buffer.from('first-').toString('base64'),
    });
    const streamed = await runner.uploadArtifactChunk({
      processId: processResult.processId,
      path: 'streamed.bin',
      offset: 6,
      contentBase64: Buffer.from('second').toString('base64'),
    });
    expect(streamed.sizeBytes).toBe(12);
    await expect(
      runner.readArtifact({ processId: processResult.processId, path: 'streamed.bin', encoding: 'utf8' })
    ).resolves.toMatchObject({ content: 'first-second' });
    await expect(runner.getWorkspaceUsage({ processId: processResult.processId })).resolves.toMatchObject({
      workspaceReservationBytes: 64 * 1024 * 1024,
      overReservation: false,
    });

    const listResult = await runner.listArtifactFiles({
      processId: processResult.processId,
      path: '.',
      maxDepth: 1,
      limit: 10,
    });
    expect(listResult.entries).toContainEqual({ path: 'result.txt', type: 'file', sizeBytes: 14 });

    const sendResult = await runner.sendArtifact({
      processId: processResult.processId,
      path: 'result.txt',
      filename: 'result.txt',
      mediaType: 'text/plain',
    });
    expect(sendResult.tempFilePath).toContain('gateway-sandbox-artifact-');
    expect(await readFile(sendResult.tempFilePath, 'utf8')).toBe('process-ready\n');
    expect((await stat(sendResult.tempFilePath)).size).toBe(sendResult.sizeBytes);
    await rm(sendResult.tempFilePath, { force: true });

    const killed = await runner.killProcess({ processId: processResult.processId });
    expect(killed.killed).toBe(true);
  }, 60_000);
});

async function waitForOutput(
  runner: AISandboxRunnerService,
  processId: string,
  expected: string
): Promise<{ output: string }> {
  const deadline = Date.now() + 5_000;
  let lastOutput = '';
  while (Date.now() < deadline) {
    const output = await runner.readProcessOutput({ processId, tail: 20 });
    lastOutput = output.output;
    if (lastOutput.includes(expected)) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for process output ${expected}. Last output: ${lastOutput}`);
}

function cleanupTestContainers(): void {
  try {
    const ids = execFileSync('docker', [
      'ps',
      '-aq',
      '--filter',
      'label=gateway.sandbox=true',
      '--filter',
      'label=gateway.sandbox.user_id=test-user',
    ])
      .toString('utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length > 0) {
      execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
    }
  } catch {
    // Best-effort cleanup only; test assertions should surface functional failures.
  }
}

function makePolicy(jobId: string, kind: 'script' | 'process', ttlSeconds: number): SandboxRunnerJobPolicy {
  return {
    jobId,
    userId: 'test-user',
    conversationId: 'test-conversation',
    kind,
    runtime: 'alpine',
    tier: 'low',
    ttlSeconds,
    requiredScopes: ['ai:sandbox:use'],
    cpuQuota: 10_000,
    memoryBytes: 256 * 1024 * 1024,
    workspaceBytes: 64 * 1024 * 1024,
    pidsLimit: 64,
  };
}
