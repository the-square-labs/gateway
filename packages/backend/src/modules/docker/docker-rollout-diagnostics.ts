import { redactDockerBuildLog } from './docker-build-policy.js';

export const DOCKER_ROLLOUT_RAW_LIMIT = 32 * 1024;
const oversized = '[Oversized diagnostic field omitted]';
function boundedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > DOCKER_ROLLOUT_RAW_LIMIT || Buffer.byteLength(value) > DOCKER_ROLLOUT_RAW_LIMIT
    ? oversized
    : value;
}

/** Never let log retrieval hold up recovery or publish unredacted runtime output. */
export async function collectDockerRolloutDiagnostics(read: {
  inspect: (timeoutMs: number) => Promise<any>;
  logs: (timeoutMs: number) => Promise<unknown>;
}): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + 3000;
  const collect = async () => {
    // Public inspect masks secrets, so use the internal snapshot solely to redact
    // all runtime environment values. Do not retain or return the snapshot.
    const inspect = await read.inspect(3000);
    if (Date.now() >= deadline) return 'Runtime diagnostics timed out';
    if (!inspect?.State || !Array.isArray(inspect?.Config?.Env)) return 'Runtime diagnostics unavailable';
    if (inspect.Config.Env.length > 256) return 'Runtime diagnostics unavailable';
    const env: string[] = inspect.Config.Env.filter((entry: unknown): entry is string => typeof entry === 'string');
    let envBytes = 0;
    for (const entry of env) {
      if (entry.length > DOCKER_ROLLOUT_RAW_LIMIT) return 'Runtime diagnostics unavailable';
      envBytes += Buffer.byteLength(entry);
      if (envBytes > DOCKER_ROLLOUT_RAW_LIMIT) return 'Runtime diagnostics unavailable';
    }
    const secretValues = env
      .map((entry: string) => entry.slice(entry.indexOf('=') + 1))
      .filter(Boolean)
      .sort((a: string, b: string) => b.length - a.length);
    const secretNames = env.map((entry: string) => entry.split('=', 1)[0]);
    const state = inspect.State;
    const healthLog = boundedText(state.Health?.Log?.at(-1)?.Output);
    let logs = 'Container logs unavailable';
    try {
      const output = await read.logs(Math.max(1, deadline - Date.now()));
      if (Date.now() >= deadline) return 'Runtime diagnostics timed out';
      if (Array.isArray(output)) {
        let bytes = 0;
        if (
          output.length > 60 ||
          output.some((line) => {
            if (typeof line !== 'string') return false;
            if (line.length > DOCKER_ROLLOUT_RAW_LIMIT) return true;
            bytes += Buffer.byteLength(line) + 1;
            return bytes > DOCKER_ROLLOUT_RAW_LIMIT;
          })
        )
          logs = oversized;
        else logs = output.filter((line) => typeof line === 'string').join('\n');
      } else if (typeof output === 'string') logs = boundedText(output);
    } catch {
      /* Diagnostic failure must not prevent rollback. */
    }
    const evidence = `Runtime: ${boundedText(state.Status) || 'unknown'}; exit code ${Number.isInteger(state.ExitCode) ? state.ExitCode : 'unknown'}; OOMKilled=${state.OOMKilled === true}\n${boundedText(state.Error)}\n${healthLog}\n${logs}`;
    // Redact before truncation, otherwise a cut token can evade value matching.
    // Replace values in one pass: short values must not repeatedly expand the
    // redaction markers emitted for other environment entries.
    const values = [...new Set(secretValues)].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const masked = values.length ? evidence.replace(new RegExp(values.join('|'), 'g'), '[REDACTED]') : evidence;
    return redactDockerBuildLog(masked, { secretNames }).slice(0, 2800);
  };
  try {
    return await Promise.race([
      collect().catch(() => 'Runtime diagnostics unavailable'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('Runtime diagnostics timed out'), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
