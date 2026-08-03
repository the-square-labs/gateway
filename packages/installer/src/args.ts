export type InstallerTarget = 'gateway' | 'node';

export interface ParsedCommand {
  target: InstallerTarget | null;
  flags: Map<string, string | boolean>;
  help: boolean;
}

const BOOLEAN_FLAGS = new Set([
  'acme-staging',
  'disable-logging',
  'dry-run',
  'no-log-rotation',
  'no-restrict-env',
  'no-logo',
  'non-interactive',
  'remote-database',
  'skip-nginx',
  'skip-start',
  'yes',
]);

const SHORT_FLAGS: Record<string, string> = { '-h': 'help', '-v': 'version', '-y': 'yes' };

export function parseCommand(argv: string[]): ParsedCommand {
  const flags = new Map<string, string | boolean>();
  let target: InstallerTarget | null = null;
  let help = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const normalized = SHORT_FLAGS[arg] ?? arg.replace(/^--/, '');
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg.startsWith('-')) {
      if (BOOLEAN_FLAGS.has(normalized)) {
        flags.set(normalized, true);
        continue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      flags.set(normalized, value);
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length === 0) return { target, flags, help };
  if (positional[0] === 'install') positional.shift();
  if (positional[0] === 'gateway' || positional[0] === 'node') target = positional[0];
  else throw new Error(`unknown command: ${positional.join(' ')}`);
  return { target, flags, help };
}

export function flagString(flags: Map<string, string | boolean>, name: string, fallback = ''): string {
  const value = flags.get(name);
  return typeof value === 'string' ? value : fallback;
}

export function flagBool(flags: Map<string, string | boolean>, name: string, fallback = false): boolean {
  return flags.get(name) === true || fallback;
}

export function engineArgs(target: InstallerTarget, flags: Map<string, string | boolean>): string[] {
  const result = ['install', target, '-y'];
  for (const [name, value] of flags) {
    if (name === 'dry-run' || name === 'help' || name === 'non-interactive' || name === 'yes') continue;
    result.push(`--${name}`);
    if (typeof value === 'string') result.push(value);
  }
  return result;
}

export function displayEngineArgs(target: InstallerTarget, flags: Map<string, string | boolean>): string[] {
  const sensitive = new Set(['token', 'oidc-client-secret', 'clickhouse-password', 'smtp-password', 'initial-admin-password']);
  const result = ['gateway-installer-engine', ...engineArgs(target, flags)];
  return result.map((value, index) => sensitive.has(result[index - 1]?.replace(/^--/, '')) ? '<redacted>' : value);
}
