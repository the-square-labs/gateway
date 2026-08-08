import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { request as httpsRequest } from 'node:https';

const MAX_RESPONSE_BODY = 2048;

export interface OutboundWebhookFetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface OutboundWebhookFetchResponse {
  status: number;
  text: () => Promise<string>;
}

/**
 * Send to a DNS address validated by OutboundWebhookPolicyService while still
 * preserving the original hostname for TLS SNI and Host. Node's native
 * request client does not follow redirects, so credentials never cross an
 * unvalidated redirect target.
 */
export async function fetchWithPinnedAddresses(
  rawUrl: string,
  addresses: string[],
  options: OutboundWebhookFetchOptions
): Promise<OutboundWebhookFetchResponse> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await fetchWithPinnedAddress(rawUrl, address, options);
    } catch (error) {
      if (options.signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Webhook request failed for all resolved addresses');
}

export function fetchWithPinnedAddress(
  rawUrl: string,
  address: string,
  options: OutboundWebhookFetchOptions
): Promise<OutboundWebhookFetchResponse> {
  const url = new URL(rawUrl);
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const lookup: NonNullable<RequestOptions['lookup']> = (_hostname, lookupOptions, callback) => {
    const family = address.includes(':') ? 6 : 4;
    const lookupCallback = (typeof lookupOptions === 'function' ? lookupOptions : callback) as (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void;
    const all =
      typeof lookupOptions === 'object' && lookupOptions !== null && 'all' in lookupOptions && lookupOptions.all;

    if (all) {
      lookupCallback(null, [{ address, family }]);
      return;
    }
    lookupCallback(null, address, family);
  };
  const requestOptions: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers:
      options.body !== undefined &&
      !Object.keys(options.headers).some((header) => header.toLowerCase() === 'content-length')
        ? { ...options.headers, 'Content-Length': Buffer.byteLength(options.body).toString() }
        : options.headers,
    lookup,
  };

  return new Promise((resolve, reject) => {
    const req = requester(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (received <= MAX_RESPONSE_BODY) {
          chunks.push(buffer.subarray(0, Math.max(0, MAX_RESPONSE_BODY + 1 - received)));
        }
        received += buffer.length;
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          text: async () => body,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    if (options.signal.aborted) {
      req.destroy(new Error('Request aborted'));
      return;
    }
    const abort = () => req.destroy(new Error('Request aborted'));
    options.signal.addEventListener('abort', abort, { once: true });
    req.on('close', () => options.signal.removeEventListener('abort', abort));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
