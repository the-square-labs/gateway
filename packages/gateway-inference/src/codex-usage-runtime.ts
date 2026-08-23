import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexUsageInterposer, JsonLineDecoder } from './codex-app-server-interposer.js';
import { GatewayUsageSource, gatewayUsageUrl } from './codex-usage.js';
import { CodexUsageComponentService, readCodexUsageState } from './codex-usage-components.js';
import { SecureCredentialStore } from './credentials.js';
import { CliError } from './errors.js';
import { inferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import type { CliPaths } from './paths.js';

const REMOTE_TOKEN_ENV = 'WIOLETT_GATEWAY_CODEX_REMOTE_TOKEN';

export async function runCodexDesktopUsageWrapper(input: { paths: CliPaths; args: string[] }): Promise<number> {
  const runtime = await runtimeContext(input.paths);
  if (!runtime.state.desktop) {
    throw new CliError('CODEX_DESKTOP_USAGE_NOT_CONFIGURED', 'Codex Desktop usage is not configured.');
  }
  const binding = runtime.state.desktop;
  await new CodexUsageComponentService(input.paths).assertRuntimeCompatible(binding);
  await ensureProxy(input.paths, runtime.state.profileName, runtime.state.remoteBaseUrl);
  const child = spawn(binding.realCodexPath, input.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnv(),
  });
  const interposer = new CodexUsageInterposer(runtime.source);
  const clientQueue = bridgeClientStream(process.stdin, child, interposer);
  const serverQueue = bridgeServerStream(child, process.stdout, interposer);
  forwardSignals(child);
  try {
    return await waitForExit(child);
  } finally {
    await Promise.all([clientQueue.drain(), serverQueue.drain()]);
  }
}

export async function runGatewayCodex(input: { paths: CliPaths; args: string[] }): Promise<number> {
  const state = await readCodexUsageState(input.paths);
  if (!state.cli) throw new CliError('CODEX_CLI_USAGE_NOT_CONFIGURED', 'gateway-codex is not configured.');
  const binding = state.cli;
  if (!isInteractiveInvocation(input.args)) {
    const child = spawn(binding.realCodexPath, input.args, { stdio: 'inherit', env: childEnv() });
    forwardSignals(child);
    return waitForExit(child);
  }
  const runtime = await runtimeContext(input.paths, state);
  await new CodexUsageComponentService(input.paths).assertRuntimeCompatible(binding);
  await ensureProxy(input.paths, runtime.state.profileName, runtime.state.remoteBaseUrl);
  const token = randomBytes(32).toString('base64url');
  let connected = false;
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: 8 * 1024 * 1024,
    verifyClient: ({ req }, done) => {
      const candidate = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const valid = !connected && equalSecret(candidate, token);
      if (valid) connected = true;
      done(valid, valid ? undefined : 401, valid ? undefined : 'Unauthorized');
    },
  });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const upstream = spawn(binding.realCodexPath, ['app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnv(),
  });
  const interposer = new CodexUsageInterposer(runtime.source);
  let bridge: WebSocketBridge | undefined;
  server.once('connection', (socket) => {
    bridge = bridgeWebSocket(socket, upstream, interposer);
  });
  upstream.once('error', () => {
    for (const client of server.clients) client.close(1011, 'Codex app-server failed');
  });
  const tui = spawn(
    binding.realCodexPath,
    ['--remote', `ws://127.0.0.1:${address.port}`, '--remote-auth-token-env', REMOTE_TOKEN_ENV, ...input.args],
    { stdio: 'inherit', env: { ...childEnv(), [REMOTE_TOKEN_ENV]: token } }
  );
  forwardSignals(tui, upstream);
  try {
    return await waitForExit(tui);
  } finally {
    await stopChild(upstream);
    await bridge?.drain();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runtimeContext(paths: CliPaths, configuredState?: Awaited<ReturnType<typeof readCodexUsageState>>) {
  const state = configuredState ?? (await readCodexUsageState(paths));
  const credentials = SecureCredentialStore.forPlatform(paths.fileCredentialsFile, paths.dataDir);
  const credential = await credentials.getRuntime(state.profileName);
  if (!credential)
    throw new CliError('RUNTIME_TOKEN_MISSING', 'Gateway inference token is missing. Run setup codex again.');
  return {
    state,
    source: new GatewayUsageSource({ usageUrl: gatewayUsageUrl(state.remoteBaseUrl), token: credential.token }),
  };
}

async function ensureProxy(paths: CliPaths, profileName: string, remoteBaseUrl: string) {
  return inferenceProxyDaemonManager.ensure({ paths, profileName, remoteBaseUrl, runtimeFile: paths.runtimeFile });
}

function bridgeClientStream(
  input: NodeJS.ReadableStream,
  child: ChildProcess,
  interposer: CodexUsageInterposer
): SerialQueue {
  const decoder = new JsonLineDecoder();
  const queue = new SerialQueue((error) => failBridge(error, child));
  input.on('data', (chunk) => {
    queue.enqueue(() =>
      processClientLines(decoder.push(chunk as Buffer), child, interposer, (line) =>
        writeStreamLine(process.stdout, line)
      )
    );
  });
  input.on('end', () => {
    queue.enqueue(async () => {
      await processClientLines(decoder.finish(), child, interposer, (line) => writeStreamLine(process.stdout, line));
      child.stdin?.end();
    });
  });
  return queue;
}

function bridgeServerStream(
  child: ChildProcess,
  output: NodeJS.WritableStream,
  interposer: CodexUsageInterposer
): SerialQueue {
  const decoder = new JsonLineDecoder();
  const queue = new SerialQueue((error) => failBridge(error, child));
  child.stdout?.on('data', (chunk) => {
    queue.enqueue(() =>
      processServerLines(
        decoder.push(chunk as Buffer),
        interposer,
        (line) => writeStreamLine(output, line),
        (pending) => scheduleDeferredNotifications(pending, queue, (line) => writeStreamLine(output, line))
      )
    );
  });
  child.stdout?.on('end', () => {
    queue.enqueue(() =>
      processServerLines(
        decoder.finish(),
        interposer,
        (line) => writeStreamLine(output, line),
        (pending) => scheduleDeferredNotifications(pending, queue, (line) => writeStreamLine(output, line))
      )
    );
  });
  const refresh = startBackgroundRefresh(interposer, (line) => writeStreamLine(output, line), queue);
  child.once('close', () => clearInterval(refresh));
  return queue;
}

interface WebSocketBridge {
  drain(): Promise<void>;
}

function bridgeWebSocket(socket: WebSocket, upstream: ChildProcess, interposer: CodexUsageInterposer): WebSocketBridge {
  const clientQueue = new SerialQueue((error) => failSocketBridge(error, socket, upstream));
  socket.on('message', (data, isBinary) => {
    if (isBinary) return socket.close(1003, 'Text frames required');
    clientQueue.enqueue(async () => {
      const { forward, respond } = await interposer.safeClientLine(data.toString());
      for (const line of forward) await writeChildLine(upstream, line);
      for (const line of respond) await sendWebSocketLine(socket, line);
    });
  });
  const decoder = new JsonLineDecoder();
  const serverQueue = new SerialQueue((error) => failSocketBridge(error, socket, upstream));
  upstream.stdout?.on('data', (chunk) => {
    serverQueue.enqueue(() =>
      processServerLines(
        decoder.push(chunk as Buffer),
        interposer,
        (line) => sendWebSocketLine(socket, line),
        (pending) => scheduleDeferredNotifications(pending, serverQueue, (line) => sendWebSocketLine(socket, line))
      )
    );
  });
  upstream.stdout?.on('end', () =>
    serverQueue.enqueue(() =>
      processServerLines(
        decoder.finish(),
        interposer,
        (line) => sendWebSocketLine(socket, line),
        (pending) => scheduleDeferredNotifications(pending, serverQueue, (line) => sendWebSocketLine(socket, line))
      )
    )
  );
  const refresh = startBackgroundRefresh(interposer, (line) => sendWebSocketLine(socket, line), serverQueue);
  socket.on('close', () => {
    clearInterval(refresh);
    upstream.stdin?.end();
  });
  upstream.once('close', () => {
    clearInterval(refresh);
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Codex app-server exited');
  });
  return { drain: () => Promise.all([clientQueue.drain(), serverQueue.drain()]).then(() => undefined) };
}

async function processClientLines(
  lines: string[],
  child: ChildProcess,
  interposer: CodexUsageInterposer,
  respond: (line: string) => Promise<void>
) {
  for (const line of lines) {
    const result = await interposer.safeClientLine(line);
    for (const forward of result.forward) await writeChildLine(child, forward);
    for (const response of result.respond) await respond(response);
  }
}

async function processServerLines(
  lines: string[],
  interposer: CodexUsageInterposer,
  send: (line: string) => Promise<void>,
  defer?: (pending: Promise<string[]>) => void
) {
  for (const line of lines) {
    const result = await interposer.handleServerLine(line);
    for (const forward of result.forward) await send(forward);
    for (const notification of result.notify) await send(notification);
    if (result.deferredNotify) defer?.(result.deferredNotify);
  }
}

export function isInteractiveInvocation(args: string[]): boolean {
  if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-V')) return false;
  if (
    args.some(
      (value) =>
        value === '--remote' ||
        value.startsWith('--remote=') ||
        value === '--remote-auth-token-env' ||
        value.startsWith('--remote-auth-token-env=')
    )
  )
    return false;
  const valueOptions = new Set([
    '-c',
    '--config',
    '--enable',
    '--disable',
    '-i',
    '--image',
    '-m',
    '--model',
    '--oss-provider',
    '--local-provider',
    '-p',
    '--profile',
    '-s',
    '--sandbox',
    '-a',
    '--ask-for-approval',
    '-C',
    '--cd',
    '--add-dir',
    '--color',
    '--remote',
    '--remote-auth-token-env',
  ]);
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') break;
    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    command = value;
    break;
  }
  if (!command) return true;
  if (command === 'resume' || command === 'fork') return true;
  const passthrough = new Set([
    'exec',
    'e',
    'review',
    'login',
    'logout',
    'mcp',
    'plugin',
    'mcp-server',
    'app-server',
    'remote-control',
    'app',
    'completion',
    'update',
    'doctor',
    'sandbox',
    'debug',
    'apply',
    'a',
    'help',
    'queue',
    'archive',
    'delete',
    'migrate-rollouts',
    'unarchive',
    'cloud',
    'exec-server',
    'features',
    'agents',
  ]);
  return !passthrough.has(command);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CODEX_CLI_PATH;
  delete env[REMOTE_TOKEN_ENV];
  return env;
}

function forwardSignals(...children: ChildProcess[]): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const child of children) child.kill(signal);
    });
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? signalExitCode(signal)));
  });
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return once(child, 'close').then(() => undefined);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const closed = await Promise.race([
    waitForClose(child).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (closed || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForClose(child);
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return signal ? 128 : 1;
}

function equalSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

class SerialQueue {
  private pending = Promise.resolve();

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(task: () => Promise<void>): void {
    this.pending = this.pending.then(task).catch(this.onError);
  }

  drain(): Promise<void> {
    return this.pending;
  }
}

function scheduleDeferredNotifications(
  pending: Promise<string[]>,
  queue: SerialQueue,
  send: (line: string) => Promise<void>
): void {
  void pending.then((notifications) => {
    queue.enqueue(async () => {
      for (const notification of notifications) await send(notification);
    });
  });
}

function startBackgroundRefresh(
  interposer: CodexUsageInterposer,
  send: (line: string) => Promise<void>,
  queue: SerialQueue
): NodeJS.Timeout {
  const timer = setInterval(() => {
    queue.enqueue(async () => {
      try {
        for (const notification of await interposer.refreshNotification()) await send(notification);
      } catch {
        // Keep the last known usage visible; explicit reads still fail closed before the first successful fetch.
      }
    });
  }, 60_000);
  timer.unref();
  return timer;
}

async function writeChildLine(child: ChildProcess, line: string): Promise<void> {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
  if (!child.stdin.write(`${line}\n`)) {
    await Promise.race([once(child.stdin, 'drain'), once(child.stdin, 'close')]);
  }
}

async function writeStreamLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, 'drain');
}

async function sendWebSocketLine(socket: WebSocket, line: string): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.send(line, (error) => (error ? reject(error) : resolve()));
  });
}

function failBridge(error: unknown, child: ChildProcess): void {
  process.stderr.write(`Codex usage bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
  child.kill('SIGTERM');
}

function failSocketBridge(error: unknown, socket: WebSocket, upstream: ChildProcess): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Gateway usage bridge failed');
  failBridge(error, upstream);
}
