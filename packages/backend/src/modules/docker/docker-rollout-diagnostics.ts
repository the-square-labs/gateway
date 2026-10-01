import { redactDockerBuildLog } from './docker-build-policy.js';

/** The most of one diagnostic field (the environment used for redaction, the health output, the log lines). */
export const DOCKER_ROLLOUT_RAW_LIMIT = 32 * 1024;
/** The most of one daemon response read for diagnostics (the inspect, the log tail). */
export const DOCKER_ROLLOUT_RESPONSE_LIMIT = 1024 * 1024;
const DOCKER_ROLLOUT_ENV_ENTRIES_MAX = 256;
const DOCKER_ROLLOUT_LOG_LINES_MAX = 60;
const oversized = '[Oversized diagnostic field omitted]';

function boundedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > DOCKER_ROLLOUT_RAW_LIMIT || Buffer.byteLength(value) > DOCKER_ROLLOUT_RAW_LIMIT
    ? oversized
    : value;
}

/** Entries small enough, together, to redact from the output; null otherwise. */
function redactable(entries: readonly unknown[]): string[] | null {
  if (entries.length > DOCKER_ROLLOUT_ENV_ENTRIES_MAX) return null;
  const values = entries.filter((entry: unknown): entry is string => typeof entry === 'string');
  let bytes = 0;
  for (const value of values) {
    bytes += Buffer.byteLength(value);
    if (value.length > DOCKER_ROLLOUT_RAW_LIMIT || bytes > DOCKER_ROLLOUT_RAW_LIMIT) return null;
  }
  return values;
}

/** The newest log lines that fit the field limit; a line too long to show is named, not cut (redaction first). */
function boundedLogLines(output: unknown): string {
  const lines = (Array.isArray(output) ? output : typeof output === 'string' ? output.split('\n') : [])
    .filter((line: unknown): line is string => typeof line === 'string')
    .slice(-DOCKER_ROLLOUT_LOG_LINES_MAX);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.reverse()) {
    const shown = line.length > DOCKER_ROLLOUT_RAW_LIMIT ? '[Oversized log line omitted]' : line;
    bytes += Buffer.byteLength(shown) + 1;
    if (bytes > DOCKER_ROLLOUT_RAW_LIMIT) break;
    kept.unshift(shown);
  }
  return kept.join('\n');
}

function runtimeLine(inspect: any): string {
  const state = inspect?.State;
  if (!state || typeof state !== 'object') return 'Runtime: state unavailable';
  const exitCode = Number.isInteger(state.ExitCode) ? state.ExitCode : 'unknown';
  const restarts = Number.isInteger(inspect.RestartCount) ? inspect.RestartCount : 'unknown';
  return `Runtime: ${boundedText(state.Status) || 'unknown'}; exit code ${exitCode}; restarts ${restarts}; OOMKilled=${state.OOMKilled === true}`;
}

/**
 * Startup evidence of a failed rollout: runtime state, exit code, restarts, the last health output and the newest
 * log lines, with the container's environment values redacted. Each field has its own limit, so a large inspect
 * (many labels, mounts or networks) still yields the evidence, and the log lines are kept when the inspect cannot be
 * read (redacted then with the values Gateway stores for the container). Never holds up recovery: one short budget.
 */
export async function collectDockerRolloutDiagnostics(read: {
  inspect: (timeoutMs: number) => Promise<any>;
  logs: (timeoutMs: number) => Promise<unknown>;
  /** Environment and secret values Gateway stores for the container, redacted when its inspect is unavailable. */
  storedValues?: () => Promise<string[]>;
}): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + 3000;
  const collect = async () => {
    // Public inspect masks secrets, so use the internal snapshot solely to redact
    // all runtime environment values. Do not retain or return the snapshot.
    let inspect: any = null;
    try {
      inspect = await read.inspect(3000);
    } catch {
      /* The log lines are still evidence. */
    }
    if (Date.now() >= deadline) return 'Runtime diagnostics timed out';
    // The values to redact: the runtime environment, or without an inspect the values Gateway stores for it.
    const env = inspect ? redactable(Array.isArray(inspect.Config?.Env) ? inspect.Config.Env : []) : [];
    const stored =
      inspect || !read.storedValues ? [] : redactable(await read.storedValues().catch(() => [] as string[]));
    let logs = 'Container logs unavailable';
    if (env === null || stored === null) {
      // Values that cannot be redacted must not reach the build error.
      logs = 'Container logs withheld: the container environment is too large to redact them';
    } else {
      try {
        const output = await read.logs(Math.max(1, deadline - Date.now()));
        if (Date.now() >= deadline) return 'Runtime diagnostics timed out';
        logs = boundedLogLines(output);
      } catch {
        /* Diagnostic failure must not prevent rollback. */
      }
    }
    const secretValues = [...(env ?? []).map((entry: string) => entry.slice(entry.indexOf('=') + 1)), ...(stored ?? [])]
      .filter(Boolean)
      .sort((a: string, b: string) => b.length - a.length);
    const secretNames = (env ?? []).map((entry: string) => entry.split('=', 1)[0]);
    const healthLog = boundedText(inspect?.State?.Health?.Log?.at(-1)?.Output);
    const evidence = `${runtimeLine(inspect)}\n${boundedText(inspect?.State?.Error)}\n${healthLog}\n${logs}`;
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
