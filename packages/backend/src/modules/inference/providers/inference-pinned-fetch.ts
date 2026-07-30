import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { ValidatedInferenceDestination } from './inference-destination-policy.js';

export async function pinnedFetch(
  rawUrl: string,
  init: RequestInit,
  destination: ValidatedInferenceDestination
): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.hostname.toLowerCase().replace(/\.$/, '') !== destination.hostname) {
    throw new Error('Pinned destination does not match request hostname');
  }
  const request = new Request(url, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const headers = Object.fromEntries(request.headers.entries());
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const upstream = transport.request(
      url,
      {
        method: request.method,
        headers,
        agent: false,
        signal: request.signal,
        lookup(_hostname, options, callback) {
          if (options.all) {
            const allCallback = callback as (
              error: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: 4 | 6 }>
            ) => void;
            allCallback(null, [{ address: destination.address, family: destination.family }]);
          } else {
            callback(null, destination.address, destination.family);
          }
        },
      },
      (response) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        }
        const status = response.statusCode ?? 502;
        const hasBody = request.method !== 'HEAD' && status !== 204 && status !== 304;
        resolve(
          new Response(hasBody ? (Readable.toWeb(response) as ReadableStream<Uint8Array>) : null, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders,
          })
        );
      }
    );
    upstream.once('error', reject);
    if (body) upstream.end(body);
    else upstream.end();
  });
}
