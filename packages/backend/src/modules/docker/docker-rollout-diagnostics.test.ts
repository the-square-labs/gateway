import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';
import { collectDockerRolloutDiagnostics } from './docker-rollout-diagnostics.js';

const failedInspect = (patch: Record<string, unknown> = {}) => ({
  Name: '/api',
  RestartCount: 4,
  State: { Status: 'restarting', ExitCode: 1, OOMKilled: false, Error: '' },
  Config: { Env: ['DATABASE_URL=postgres://app:hunter2@db:5432/app', 'MODE=production'] },
  ...patch,
});

describe('rollout failure diagnostics', () => {
  it('reports the restarts and the log lines of a container with a large inspect, redacted', async () => {
    const labels = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`label.${index}`, 'x'.repeat(100)]));
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect({ Config: { ...failedInspect().Config, Labels: labels } }),
      logs: async () => ['booting', 'connecting to postgres://app:hunter2@db:5432/app', 'fatal: migration failed'],
    });

    expect(diagnostics).toContain('Runtime: restarting; exit code 1; restarts 4; OOMKilled=false');
    expect(diagnostics).toContain('fatal: migration failed');
    expect(diagnostics).not.toContain('hunter2');
  });

  it('keeps the log lines when the inspect cannot be read, redacted with the values Gateway stores', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => {
        throw new Error('inspect timed out');
      },
      logs: async () => ['token=s3cr3t-value accepted', 'listening'],
      storedValues: async () => ['s3cr3t-value'],
    });

    expect(diagnostics).toContain('Runtime: state unavailable');
    expect(diagnostics).toContain('listening');
    expect(diagnostics).not.toContain('s3cr3t-value');
  });

  it('keeps the newest log lines that fit and names a line too long to show', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect(),
      logs: async () => ['y'.repeat(40 * 1024), 'last words'],
    });

    expect(diagnostics).toContain('[Oversized log line omitted]\nlast words');
  });

  it('withholds the log lines when the environment is too large to redact', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect({ Config: { Env: Array.from({ length: 300 }, (_, i) => `V${i}=v`) } }),
      logs: vi.fn(async () => ['secret output']),
    });

    expect(diagnostics).toContain('Container logs withheld');
    expect(diagnostics).not.toContain('secret output');
  });

  it('reads an inspect larger than one field limit from the node', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async () => ({
        success: true,
        detail: JSON.stringify(
          failedInspect({ Mounts: Array.from({ length: 300 }, (_, i) => ({ Source: `/data/${'m'.repeat(200)}${i}` })) })
        ),
      })),
      sendDockerLogsCommand: vi.fn(async () => ({ success: true, detail: JSON.stringify(['fatal: port in use']) })),
    };
    const service = new DockerManagementService({} as never, {} as never, dispatch as never, {} as never);

    const diagnostics = await service.getContainerFailureDiagnostics('node-1', 'container-1');

    expect(diagnostics).toContain('restarts 4');
    expect(diagnostics).toContain('fatal: port in use');
  });
});
