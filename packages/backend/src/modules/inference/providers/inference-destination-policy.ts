import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { injectable } from 'tsyringe';
import { AppError } from '@/middleware/error-handler.js';

type Resolver = typeof lookup;

export interface ValidatedInferenceDestination {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

@injectable()
export class InferenceDestinationPolicy {
  constructor(private readonly resolver: Resolver = lookup) {}

  async assertAllowed(rawUrl: string, allowPrivateNetwork: boolean): Promise<ValidatedInferenceDestination> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError(400, 'INFERENCE_DESTINATION_INVALID', 'Provider destination is not a valid URL');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new AppError(
        400,
        'INFERENCE_DESTINATION_INVALID',
        'Provider destination must be HTTP(S) without credentials'
      );
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname === 'metadata.google.internal' || hostname.endsWith('.metadata.google.internal')) {
      throw blocked();
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolver(hostname, { all: true, verbatim: true }).catch(() => {
          throw new AppError(400, 'INFERENCE_DESTINATION_UNRESOLVED', 'Provider destination could not be resolved');
        });
    if (!addresses.length)
      throw new AppError(400, 'INFERENCE_DESTINATION_UNRESOLVED', 'Provider destination has no addresses');
    for (const { address } of addresses) assertAddress(address, allowPrivateNetwork);
    const selected = addresses[0]!;
    return { url, hostname, address: selected.address, family: selected.family as 4 | 6 };
  }
}

function assertAddress(address: string, allowPrivateNetwork: boolean): void {
  const normalized = address.toLowerCase().split('%')[0]!;
  if (isIpv4(normalized)) {
    const [a, b] = normalized.split('.').map(Number);
    const loopback = a === 127;
    const privateNetwork = a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
    const linkLocal = a === 169 && b === 254;
    const invalid = a === 0 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127);
    if (linkLocal || invalid || (!allowPrivateNetwork && (loopback || privateNetwork))) throw blocked();
    return;
  }
  if (normalized === '::' || normalized === '::1') {
    if (!allowPrivateNetwork || normalized === '::') throw blocked();
    return;
  }
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    throw blocked();
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    if (!allowPrivateNetwork) throw blocked();
    return;
  }
  if (normalized.startsWith('ff')) throw blocked();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) assertAddress(mapped, allowPrivateNetwork);
}

function isIpv4(value: string): boolean {
  return isIP(value) === 4;
}

function blocked(): AppError {
  return new AppError(400, 'INFERENCE_DESTINATION_BLOCKED', 'Provider destination is blocked by network policy');
}

export const __testOnly = { assertAddress };
