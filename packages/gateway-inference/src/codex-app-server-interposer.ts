import {
  type GatewayUsage,
  type GatewayUsageSource,
  projectCodexAccountUsage,
  projectCodexRateLimits,
} from './codex-usage.js';
import { CliError } from './errors.js';

type RequestId = string | number;
type RpcMessage = { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: unknown };

export class CodexUsageInterposer {
  constructor(private readonly source: GatewayUsageSource) {}

  async handleClientLine(line: string): Promise<{ forward: string[]; respond: string[] }> {
    const message = parseMessage(line);
    if (!message || message.id === undefined) return { forward: [line], respond: [] };
    if (message.method === 'account/rateLimits/read') {
      return { forward: [], respond: [response(message.id, projectCodexRateLimits(await this.source.read()))] };
    }
    if (message.method === 'account/usage/read') {
      return { forward: [], respond: [response(message.id, projectCodexAccountUsage(await this.source.read()))] };
    }
    return { forward: [line], respond: [] };
  }

  async handleServerLine(
    line: string
  ): Promise<{ forward: string[]; notify: string[]; deferredNotify?: Promise<string[]> }> {
    const message = parseMessage(line);
    if (message?.method === 'account/rateLimits/updated') return { forward: [], notify: [] };
    if (message?.method !== 'turn/completed') return { forward: [line], notify: [] };
    return { forward: [line], notify: [], deferredNotify: this.refreshNotification().catch(() => []) };
  }

  async refreshNotification(): Promise<string[]> {
    const usage = await this.source.read();
    if (!this.source.changed(usage)) return [];
    return [
      JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: projectCodexRateLimits(usage).rateLimits },
      }),
    ];
  }

  async safeClientLine(line: string): Promise<{ forward: string[]; respond: string[] }> {
    try {
      return await this.handleClientLine(line);
    } catch (error) {
      const message = parseMessage(line);
      if (!message || message.id === undefined) throw error;
      const failure =
        error instanceof CliError ? error : new CliError('CODEX_USAGE_UNAVAILABLE', 'Gateway usage is unavailable.');
      return {
        forward: [],
        respond: [
          JSON.stringify({
            id: message.id,
            error: { code: -32001, message: failure.message, data: { code: failure.code } },
          }),
        ],
      };
    }
  }
}

export class JsonLineDecoder {
  private buffered = '';

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  push(chunk: string | Buffer): string[] {
    this.buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (Buffer.byteLength(this.buffered) > this.maxBytes) {
      this.buffered = '';
      throw new CliError('CODEX_PROTOCOL_FRAME_TOO_LARGE', 'Codex app-server frame exceeded the size limit.');
    }
    const lines = this.buffered.split('\n');
    this.buffered = lines.pop() ?? '';
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  finish(): string[] {
    if (!this.buffered) return [];
    const line = this.buffered;
    this.buffered = '';
    return [line];
  }
}

function parseMessage(line: string): RpcMessage | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as RpcMessage) : null;
  } catch {
    return null;
  }
}

function response(id: RequestId, result: unknown): string {
  return JSON.stringify({ id, result });
}

export function usageNotification(usage: GatewayUsage): string {
  return JSON.stringify({
    method: 'account/rateLimits/updated',
    params: { rateLimits: projectCodexRateLimits(usage).rateLimits },
  });
}
