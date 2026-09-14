import { describe, expect, it, vi } from 'vitest';
import { collectDockerRolloutDiagnostics } from './docker-rollout-diagnostics.js';

describe('rollout diagnostics', () => {
  it('omits oversized raw fields rather than joining or partially redacting them', async () => {
    const huge = 'private-value'.repeat(100_000);
    const output = await collectDockerRolloutDiagnostics({
      inspect: async () => ({
        Config: { Env: ['TOKEN=private-value'] },
        State: { Status: 'exited', ExitCode: 1, Error: huge, Health: { Log: [{ Output: huge }] } },
      }),
      logs: async () => [huge],
    });
    expect(output).toContain('Oversized diagnostic field omitted');
    expect(output).not.toContain('private-value');
    expect(output.length).toBeLessThan(1000);
  });

  it('fails closed on excessive environment data', async () => {
    const logs = vi.fn();
    await expect(
      collectDockerRolloutDiagnostics({
        inspect: async () => ({ Config: { Env: [`TOKEN=${'x'.repeat(40_000)}`] }, State: {} }),
        logs,
      })
    ).resolves.toBe('Runtime diagnostics unavailable');
    expect(logs).not.toHaveBeenCalled();
  });

  it('passes remaining transport deadlines and does not start logs after timed-out inspection', async () => {
    vi.useFakeTimers();
    try {
      const inspect = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { Config: { Env: [] }, State: { Status: 'exited' } };
      });
      const logs = vi.fn(async () => []);
      const first = collectDockerRolloutDiagnostics({ inspect, logs });
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      expect(inspect).toHaveBeenCalledWith(3000);
      expect(logs).toHaveBeenCalledWith(2000);

      let finishInspect!: (value: unknown) => void;
      const lateLogs = vi.fn();
      const late = collectDockerRolloutDiagnostics({
        inspect: () =>
          new Promise((resolve) => {
            finishInspect = resolve;
          }),
        logs: lateLogs,
      });
      await vi.advanceTimersByTimeAsync(3000);
      await expect(late).resolves.toBe('Runtime diagnostics timed out');
      finishInspect({ Config: { Env: [] }, State: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(lateLogs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures exit and startup evidence while redacting environment, health output and credential URLs', async () => {
    const output = await collectDockerRolloutDiagnostics({
      inspect: async () => ({
        Config: { Env: ['TOKEN=abc', 'LONG_TOKEN=abc-private-value'] },
        State: {
          Status: 'restarting',
          ExitCode: 1,
          Error: 'abc-private-value',
          Health: { Log: [{ Output: 'TOKEN=abc' }] },
        },
      }),
      logs: async () => [
        'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
        'abc-private-value abc https://user:password@example.com/',
        'LONG_TOKEN=other-value',
        'x'.repeat(5000),
      ],
    });
    expect(output).toContain('exit code 1');
    expect(output).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(output).not.toMatch(/abc|private-value|password|other-value/);
    expect(output.length).toBeLessThanOrEqual(2800);
  });
  it('does not read logs if the environment needed for redaction is unavailable', async () => {
    const logs = vi.fn();
    await expect(
      collectDockerRolloutDiagnostics({
        inspect: async () => {
          throw new Error('inspect failed');
        },
        logs,
      })
    ).resolves.toBe('Runtime diagnostics unavailable');
    expect(logs).not.toHaveBeenCalled();
  });
  it('retains process evidence if log collection fails', async () => {
    await expect(
      collectDockerRolloutDiagnostics({
        inspect: async () => ({ Config: { Env: [] }, State: { Status: 'exited', ExitCode: 137, OOMKilled: true } }),
        logs: async () => {
          throw new Error('secret transport details');
        },
      })
    ).resolves.toContain('exit code 137; OOMKilled=true');
  });
  it('bounds collection time and clears the timeout', async () => {
    vi.useFakeTimers();
    try {
      const diagnostics = collectDockerRolloutDiagnostics({ inspect: () => new Promise(() => {}), logs: vi.fn() });
      await vi.advanceTimersByTimeAsync(3000);
      await expect(diagnostics).resolves.toBe('Runtime diagnostics timed out');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
