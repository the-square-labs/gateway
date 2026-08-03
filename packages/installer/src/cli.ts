#!/usr/bin/env node
import * as p from '@clack/prompts';
import { existsSync } from 'node:fs';
import { stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { displayEngineArgs, engineArgs, flagBool, flagString, parseCommand, type InstallerTarget } from './args.js';

const VERSION = process.env.GATEWAY_INSTALLER_VERSION ?? 'dev';
const DEFAULT_GITLAB_URL = process.env.GATEWAY_GITLAB_URL ?? 'https://gitlab.wiolett.net';
const DEFAULT_GITLAB_PROJECT = process.env.GATEWAY_GITLAB_PROJECT ?? 'wiolett/gateway';

const SMTP_PRESETS = {
  generic: {
    label: 'Generic SMTP',
    hint: 'Configure any standards-compliant SMTP relay manually',
  },
  resend: {
    label: 'Resend',
    hint: 'smtp.resend.com · STARTTLS · API key as password',
    host: 'smtp.resend.com',
    port: '587',
    tlsMode: 'starttls',
    username: 'resend',
  },
  postmark: {
    label: 'Postmark',
    hint: 'smtp.postmarkapp.com · STARTTLS · SMTP or Server API token',
    host: 'smtp.postmarkapp.com',
    port: '587',
    tlsMode: 'starttls',
    username: '',
  },
  sendgrid: {
    label: 'Twilio SendGrid',
    hint: 'smtp.sendgrid.net · STARTTLS · API key as password',
    host: 'smtp.sendgrid.net',
    port: '587',
    tlsMode: 'starttls',
    username: 'apikey',
  },
} as const;

function usage(): string {
  return `gateway-installer ${VERSION}

Usage:
  gateway-installer install gateway [flags]
  gateway-installer install node [flags]

The installer keeps values copied from Gateway as defaults and asks only for
missing configuration. Add -y/--yes to disable prompts.

Node flags: --type --gateway --host --port --token --gateway-cert-sha256
            --version --user --storage-root --skip-nginx --nginx-repo --nginx-mode

Gateway flags: --domain --auth-methods --oidc-issuer --oidc-client-id --oidc-client-secret
               --smtp-host --smtp-port --smtp-username --smtp-password --smtp-sender-email
               --initial-admin-email --initial-admin-name --initial-admin-method
               --initial-admin-password --resource-profile --database-url --logging-mode --skip-start

Use --dry-run to validate configuration and show the engine command without
changing the host.
`;
}

function cancel(message: string): never {
  p.cancel(message);
  process.exit(1);
}

async function text(message: string, initialValue: string, placeholder: string, validate?: (value: string) => string | undefined, secret = false): Promise<string> {
  const options = { message, initialValue, placeholder, validate: (value: string | undefined) => validate?.(value ?? '') };
  const result = secret ? await p.password(options) : await p.text(options);
  if (p.isCancel(result)) cancel('Installation cancelled.');
  return result.trim();
}

function info(message: string): void {
  // Clack's log renderer preserves the guide on explicit newlines, but not on
  // terminal-driven wrapping. Wrap before rendering so continuation lines keep
  // the same left guide and never start at column zero.
  const width = Math.max(20, (process.stdout.columns ?? 80) - 4);
  const lines: string[] = [];
  for (const paragraph of message.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  p.log.info(lines.join('\n'));
}

function required(label: string): (value: string) => string | undefined {
  return (value) => value.trim() ? undefined : `${label} is required.`;
}

async function selectTarget(): Promise<InstallerTarget> {
  const result = await p.select({
    message: 'What do you want to install?',
    options: [
      { value: 'gateway', label: 'Gateway control plane', hint: 'Management API, UI, and local services' },
      { value: 'node', label: 'Managed node', hint: 'Nginx, Docker, databases, or monitoring' },
    ],
  });
  if (p.isCancel(result)) cancel('Installation cancelled.');
  return result;
}

async function storageCandidates(): Promise<Array<{ value: string; label: string; hint: string }>> {
  const ignored = new Set(['/proc', '/sys', '/dev', '/run', '/snap']);
  const virtualFilesystems = new Set(['aufs', 'cgroup', 'cgroup2', 'devpts', 'devtmpfs', 'mqueue', 'nsfs', 'overlay', 'proc', 'pstore', 'securityfs', 'sysfs', 'tmpfs', 'tracefs']);
  const roots = new Set<string>();
  try {
    const mounts = await readMounts();
    for (const { mount, filesystem } of mounts) {
      if (mount === '/' || [...ignored].some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))) continue;
      if (virtualFilesystems.has(filesystem)) continue;
      roots.add(mount);
    }
  } catch {
    // A custom path remains available below.
  }
  const candidates = await Promise.all([...roots].sort().map(async (mount) => {
    try {
      if (!(await stat(mount)).isDirectory()) return null;
      const stats = await statfs(mount);
      const free = Number(stats.bavail) * Number(stats.bsize);
      return { value: join(mount, 'gateway-databases'), label: mount, hint: `${formatBytes(free)} free` };
    } catch {
      return null;
    }
  }));
  return candidates.filter((candidate): candidate is { value: string; label: string; hint: string } => candidate !== null);
}

async function defaultStorageCandidate(): Promise<{ value: string; label: string; hint: string }> {
  const value = '/var/lib/docker-daemon/databases';
  try {
    const stats = await statfs('/');
    const free = Number(stats.bavail) * Number(stats.bsize);
    return { value, label: 'Use the current system disk', hint: `${formatBytes(free)} free · creates ${value}` };
  } catch {
    return { value, label: 'Use the current system disk', hint: `Creates ${value}` };
  }
}

async function readMounts(): Promise<Array<{ mount: string; filesystem: string }>> {
  const file = await import('node:fs/promises').then(({ readFile }) => readFile('/proc/mounts', 'utf8'));
  return file.split('\n').flatMap((line) => {
    const fields = line.split(' ');
    return fields.length >= 3 ? [{ mount: fields[1].replace(/\\040/g, ' '), filesystem: fields[2] }] : [];
  });
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

async function promptStorageRoot(existing: string): Promise<string> {
  if (existing) return existing;
  const candidates = await storageCandidates();
  const defaultCandidate = await defaultStorageCandidate();
  const answer = await p.select({
    message: 'Where should database image files be stored?',
    options: [
      defaultCandidate,
      ...candidates,
      { value: 'custom', label: 'Choose a path manually', hint: 'Use an existing or creatable absolute path' },
    ],
  });
  if (p.isCancel(answer)) cancel('Installation cancelled.');
  if (answer !== 'custom') return answer;
  return text('Database storage root', '', '/mnt/fast-ssd/gateway-databases', (value) => {
    if (!value.startsWith('/') || value === '/') return 'Enter an absolute path other than /.';
    return undefined;
  });
}

async function promptMissingValue(
  flags: Map<string, string | boolean>,
  name: string,
  message: string,
  placeholder: string,
  validate: (value: string) => string | undefined,
  secret = false,
  fallback = '',
): Promise<void> {
  if (flagString(flags, name)) return;
  flags.set(name, await text(message, fallback, placeholder, validate, secret));
}

async function promptSmtpPreset(flags: Map<string, string | boolean>): Promise<void> {
  if (flagString(flags, 'smtp-host') || flagString(flags, 'smtp-port') || flagString(flags, 'smtp-tls-mode')) return;
  const selected = await p.select({
    message: 'Choose your SMTP provider',
    options: Object.entries(SMTP_PRESETS).map(([value, preset]) => ({ value, label: preset.label, hint: preset.hint })),
  });
  if (p.isCancel(selected)) cancel('Installation cancelled.');
  const preset = SMTP_PRESETS[selected as keyof typeof SMTP_PRESETS];
  if ('host' in preset) {
    flags.set('smtp-host', preset.host);
    flags.set('smtp-port', preset.port);
    flags.set('smtp-tls-mode', preset.tlsMode);
    if (preset.username) flags.set('smtp-username', preset.username);
  }
}

async function promptNode(flags: Map<string, string | boolean>): Promise<void> {
  const configuredGateway = flagString(flags, 'gateway', process.env.GATEWAY_NODE_ADDRESS ?? '');
  if (configuredGateway) {
    const gatewayChoice = await p.select({
      message: `Use configured Gateway ${configuredGateway}?`,
      options: [
        { value: 'keep', label: `Use ${configuredGateway}`, hint: 'Recommended' },
        { value: 'change', label: 'Change Gateway address', hint: 'Enter another host:port endpoint' },
      ],
    });
    if (p.isCancel(gatewayChoice)) cancel('Installation cancelled.');
    if (gatewayChoice === 'change') {
      flags.set('gateway', await text('Gateway gRPC address', configuredGateway, 'gateway.example.com:9443', required('Gateway address')));
    }
  }
  if (!flagString(flags, 'type')) {
    const selected = await p.select({
      message: 'Which node should be installed?',
      options: [
        { value: 'nginx', label: 'Nginx reverse proxy', hint: 'Routes HTTP(S) traffic' },
        { value: 'docker', label: 'Docker workloads', hint: 'Runs managed containers' },
        { value: 'databases', label: 'Managed databases', hint: 'Runs databases backed by local image files' },
        { value: 'monitoring', label: 'Host monitoring', hint: 'Collects host metrics and status' },
      ],
    });
    if (p.isCancel(selected)) cancel('Installation cancelled.');
    flags.set('type', selected);
  }
  await promptMissingValue(flags, 'gateway', 'Gateway gRPC address', 'gateway.example.com:9443', required('Gateway address'), false, process.env.GATEWAY_NODE_ADDRESS ?? '');
  await promptMissingValue(flags, 'token', 'Enrollment token', 'gw_node_…', required('Enrollment token'), true, process.env.GATEWAY_NODE_TOKEN ?? '');
  await promptMissingValue(flags, 'gateway-cert-sha256', 'Gateway certificate fingerprint', 'sha256:…', required('Certificate fingerprint'), false, process.env.GATEWAY_NODE_CERT_SHA256 ?? '');
  if (flagString(flags, 'type') === 'databases') flags.set('storage-root', await promptStorageRoot(flagString(flags, 'storage-root')));

  p.note([
    `Node type: ${flagString(flags, 'type')}`,
    `Gateway: ${flagString(flags, 'gateway')}`,
    `Enrollment token: ${flagString(flags, 'token') ? 'provided' : 'missing'}`,
    `Certificate fingerprint: ${flagString(flags, 'gateway-cert-sha256') ? 'provided' : 'missing'}`,
    `Storage: ${flagString(flags, 'storage-root') || 'not applicable'}`,
  ].join('\n'), 'Ready to install');
  const confirmed = await p.confirm({ message: 'Install with these settings?', initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) cancel('Installation cancelled.');
}

async function promptGateway(flags: Map<string, string | boolean>): Promise<void> {
  p.note([
    'This guided setup installs the Gateway control plane on this host.',
    '',
    'You will choose a domain, configure sign-in, and create the first administrator.',
    'Nothing changes on this server until the final confirmation.',
    '',
    'Press Ctrl+C at any time to cancel safely.',
  ].join('\n'), 'Welcome to Wiolett Gateway');
  info('The Gateway domain is the address users open in their browser. Leave it blank if you want to configure DNS later.');
  const configuredDomain = flagString(flags, 'domain');
  if (configuredDomain) {
    const domainChoice = await p.select({
      message: `Use configured domain ${configuredDomain}?`,
      options: [
        { value: 'keep', label: `Use ${configuredDomain}`, hint: 'Recommended' },
        { value: 'change', label: 'Change domain', hint: 'Enter another domain or leave empty for direct access' },
      ],
    });
    if (p.isCancel(domainChoice)) cancel('Installation cancelled.');
    if (domainChoice === 'change') {
      flags.set('domain', await text('Gateway domain (optional)', configuredDomain, 'gateway.example.com'));
    }
  } else {
    await promptMissingValue(flags, 'domain', 'Gateway domain (optional)', 'gateway.example.com', () => undefined);
  }
  let methods = flagString(flags, 'auth-methods').split(',').filter(Boolean);
  if (methods.length === 0) {
    info('You can enable more than one sign-in method. Gateway users will see all enabled options on the sign-in page.');
    const selected = await p.multiselect({
      message: 'Which sign-in methods should Gateway offer?',
      options: [
        { value: 'oidc', label: 'OIDC', hint: 'Use your identity provider' },
        { value: 'password', label: 'Email and password', hint: 'Passwords and recovery links via SMTP' },
        { value: 'emailOtp', label: 'Email one-time code', hint: 'Passwordless login via SMTP' },
      ],
      required: true,
    });
    if (p.isCancel(selected)) cancel('Installation cancelled.');
    methods = selected;
    flags.set('auth-methods', methods.join(','));
  }
  const usesEmail = methods.includes('password') || methods.includes('emailOtp');
  if (usesEmail) {
    info('Email sign-in requires SMTP to deliver one-time codes and password-recovery emails. Choose a preset or configure another SMTP relay.');
    await promptSmtpPreset(flags);
    await promptMissingValue(flags, 'smtp-host', 'SMTP host', 'smtp.example.com', required('SMTP host'));
    await promptMissingValue(flags, 'smtp-port', 'SMTP port', '587', required('SMTP port'));
    const mode = flagString(flags, 'smtp-tls-mode');
    if (!mode) {
      const selected = await p.select({ message: 'SMTP transport security', options: [{ value: 'starttls', label: 'STARTTLS', hint: 'Recommended for port 587' }, { value: 'tls', label: 'TLS', hint: 'Implicit TLS, usually port 465' }] });
      if (p.isCancel(selected)) cancel('Installation cancelled.');
      flags.set('smtp-tls-mode', selected);
    }
    await promptMissingValue(flags, 'smtp-username', 'SMTP username', 'username', () => undefined);
    await promptMissingValue(flags, 'smtp-password', 'SMTP password', '••••••••', required('SMTP password'), true);
    await promptMissingValue(flags, 'smtp-sender-name', 'SMTP sender name', 'Gateway', required('Sender name'), false, 'Gateway');
    await promptMissingValue(flags, 'smtp-sender-email', 'SMTP sender email', 'gateway@example.com', required('Sender email'));
  }
  if (methods.includes('oidc')) {
    info('Create an OIDC client in your identity provider first. The redirect URI shown below must be allowed by that client.');
    await promptMissingValue(flags, 'oidc-issuer', 'OIDC issuer URL', 'https://id.example.com', required('OIDC issuer'));
    await promptMissingValue(flags, 'oidc-client-id', 'OIDC client ID', 'gateway', required('OIDC client ID'), false, 'gateway');
    await promptMissingValue(flags, 'oidc-client-secret', 'OIDC client secret', '••••••••', required('OIDC client secret'), true);
    await promptMissingValue(flags, 'oidc-redirect-uri', 'OIDC redirect URI', `${flagString(flags, 'domain') ? `https://${flagString(flags, 'domain')}` : 'http://localhost:3000'}/auth/callback`, required('OIDC redirect URI'));
  }
  let adminMethod = flagString(flags, 'initial-admin-method');
  if (!adminMethod) {
    info('The first administrator receives Gateway admin access immediately after installation.');
    const selected = await p.select({ message: 'How will the initial administrator sign in?', options: methods.map((method) => ({ value: method, label: method === 'oidc' ? 'OIDC' : method === 'password' ? 'Email and password' : 'Email one-time code' })) });
    if (p.isCancel(selected)) cancel('Installation cancelled.');
    adminMethod = selected;
    flags.set('initial-admin-method', adminMethod);
  }
  await promptMissingValue(flags, 'initial-admin-email', 'Initial administrator email', 'admin@example.com', required('Administrator email'));
  await promptMissingValue(flags, 'initial-admin-name', 'Initial administrator name', 'Gateway administrator', required('Administrator name'), false, 'Gateway administrator');
  if (adminMethod === 'password' && !flagString(flags, 'initial-admin-password')) {
    const password = await text('Initial administrator password (optional)', '', 'Leave blank to use Forgot password after installation', () => undefined, true);
    if (password) flags.set('initial-admin-password', password);
  }
  p.note([
    `Domain: ${flagString(flags, 'domain') || 'direct access on :3000'}`,
    `Sign-in methods: ${methods.join(', ')}`,
    `Initial administrator: ${flagString(flags, 'initial-admin-email')} (${adminMethod})`,
    usesEmail ? 'SMTP: will be verified by a test email during setup' : '',
  ].filter(Boolean).join('\n'), 'Ready to install');
  const confirmed = await p.confirm({ message: 'Install Gateway with these settings?', initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) cancel('Installation cancelled.');
}

function requireGatewayFlags(flags: Map<string, string | boolean>): void {
  const methods = flagString(flags, 'auth-methods').split(',').filter(Boolean);
  if (methods.length === 0) throw new Error('--auth-methods is required with --yes');
  for (const method of methods) if (!['oidc', 'password', 'emailOtp'].includes(method)) throw new Error('--auth-methods accepts oidc,password,emailOtp');
  for (const name of ['initial-admin-email', 'initial-admin-name', 'initial-admin-method']) if (!flagString(flags, name)) throw new Error(`--${name} is required with --yes`);
  if (!methods.includes(flagString(flags, 'initial-admin-method'))) throw new Error('--initial-admin-method must be enabled in --auth-methods');
  if (methods.includes('oidc')) for (const name of ['oidc-issuer', 'oidc-client-id', 'oidc-client-secret', 'oidc-redirect-uri']) if (!flagString(flags, name)) throw new Error(`--${name} is required when OIDC is enabled with --yes`);
  if (methods.includes('password') || methods.includes('emailOtp')) for (const name of ['smtp-host', 'smtp-port', 'smtp-tls-mode', 'smtp-password', 'smtp-sender-name', 'smtp-sender-email']) if (!flagString(flags, name)) throw new Error(`--${name} is required when email sign-in is enabled with --yes`);
}

function requireNodeFlags(flags: Map<string, string | boolean>): void {
  for (const name of ['type', 'gateway', 'token', 'gateway-cert-sha256']) if (!flagString(flags, name)) throw new Error(`--${name} is required with --yes`);
  if (flagString(flags, 'type') === 'databases' && !flagString(flags, 'storage-root')) throw new Error('--storage-root is required for a databases node with --yes');
}

function enginePath(): string {
  if (process.env.GATEWAY_INSTALLER_ENGINE) return process.env.GATEWAY_INSTALLER_ENGINE;
  const here = dirname(fileURLToPath(import.meta.url));
  const archiveEngine = resolve(here, '../bin/gateway-installer-engine');
  if (existsSync(archiveEngine)) return archiveEngine;
  return resolve(here, '../gateway-installer-engine');
}

const ENGINE_STEP_PREFIX = '@@wiolett-step:';

class EngineRunError extends Error {
  constructor(logPath: string) {
    super(`Installation failed. Technical details were saved to ${logPath}.`);
  }
}

async function runEngine(target: InstallerTarget, flags: Map<string, string | boolean>, spinner: { message(message: string): void }): Promise<void> {
  const binary = enginePath();
  if (!existsSync(binary)) throw new Error(`installer engine not found: ${binary}`);
  const logPath = `/tmp/wiolett-installer-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, engineArgs(target, flags), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GATEWAY_INSTALLER_UI: '1' },
    });
    let output = '';
    let pending = '';
    const receive = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(ENGINE_STEP_PREFIX)) spinner.message(line.slice(ENGINE_STEP_PREFIX.length));
      }
    };
    child.stdout?.on('data', receive);
    child.stderr?.on('data', receive);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      void writeFile(logPath, output, { mode: 0o600 }).then(
        () => reject(new EngineRunError(logPath)),
        () => reject(new Error(`Installation failed (engine exit code ${code ?? 'unknown'}).`)),
      );
    });
  });
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.help) { process.stdout.write(usage()); return; }
  const target = command.target ?? (flagBool(command.flags, 'yes') ? null : await selectTarget());
  if (!target) throw new Error('choose install gateway or install node; use --help for commands');
  if (!flagString(command.flags, 'gitlab-url')) command.flags.set('gitlab-url', DEFAULT_GITLAB_URL);
  if (!flagString(command.flags, 'gitlab-project')) command.flags.set('gitlab-project', DEFAULT_GITLAB_PROJECT);
  const nonInteractive = flagBool(command.flags, 'yes') || flagBool(command.flags, 'non-interactive');
  if (!flagBool(command.flags, 'no-logo')) p.intro('Wiolett Gateway Installer');
  if (nonInteractive && target === 'node') requireNodeFlags(command.flags);
  if (nonInteractive && target === 'gateway') requireGatewayFlags(command.flags);
  if (!nonInteractive) target === 'node' ? await promptNode(command.flags) : await promptGateway(command.flags);
  if (flagBool(command.flags, 'dry-run')) {
    p.note(displayEngineArgs(target, command.flags).join(' '), 'Dry run: engine command');
    p.outro('Configuration is valid. No host changes were made.');
    return;
  }
  const spinner = p.spinner();
  spinner.start('Checking server requirements');
  try {
    await runEngine(target, command.flags, spinner);
    spinner.stop(target === 'gateway' ? 'Gateway installation complete' : 'Node installation complete');
  } catch (error) {
    spinner.stop('Installation failed');
    throw error;
  }
  p.outro(target === 'gateway' ? 'Gateway installation completed.' : 'Node installation completed.');
}

main().catch((error: unknown) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
