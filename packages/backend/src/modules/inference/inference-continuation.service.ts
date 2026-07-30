import { inject, injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { RedisClient } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { InferenceMessage, InferenceOutputItem } from './protocol/inference-protocol.types.js';

interface ContinuationPayload {
  userId: string;
  model: string;
  messages: InferenceMessage[];
  output: InferenceOutputItem[];
  affinityKey?: string;
  createdAt: string;
}

interface StoredContinuation {
  encryptedKey: string;
  encryptedDek: string;
}

export type ContinuationLoadResult =
  | { status: 'found'; payload: ContinuationPayload }
  | { status: 'missing' }
  | { status: 'forbidden' };

@injectable()
export class InferenceContinuationService {
  constructor(
    @inject(TOKENS.RedisClient) private readonly redis: RedisClient,
    private readonly cryptoService: CryptoService
  ) {}

  async remember(responseId: string, payload: Omit<ContinuationPayload, 'createdAt'>): Promise<void> {
    const serialized = JSON.stringify({ ...payload, createdAt: new Date().toISOString() });
    const bytes = Buffer.byteLength(serialized);
    if (bytes > getEnv().INFERENCE_CONTINUATION_MAX_BYTES) {
      throw new Error('Continuation state exceeds the configured size limit');
    }
    const encrypted = this.cryptoService.encryptString(serialized);
    await this.redis.set(
      this.key(responseId),
      JSON.stringify(encrypted satisfies StoredContinuation),
      'EX',
      getEnv().INFERENCE_CONTINUATION_TTL_SECONDS
    );
  }

  async load(responseId: string, userId: string): Promise<ContinuationLoadResult> {
    const raw = await this.redis.get(this.key(responseId));
    if (!raw) return { status: 'missing' };

    let stored: StoredContinuation;
    try {
      stored = JSON.parse(raw) as StoredContinuation;
    } catch {
      return { status: 'missing' };
    }
    let payload: ContinuationPayload;
    try {
      const serialized = this.cryptoService.decryptString(stored);
      payload = JSON.parse(serialized) as ContinuationPayload;
    } catch {
      return { status: 'missing' };
    }
    if (payload.userId !== userId) return { status: 'forbidden' };
    return { status: 'found', payload };
  }

  private key(responseId: string): string {
    return `inference:continuation:${responseId}`;
  }
}
