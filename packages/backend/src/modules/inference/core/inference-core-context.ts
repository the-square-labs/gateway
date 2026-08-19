import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  INFERENCE_CORE_CONTEXT_HEADERS,
  WIOLETT_CORE_CONTRACT_ID,
  type InferenceCoreRequestContext,
} from './inference-core.contract.js';

/** Bounded lifetime for a signed data-plane context (core enforces ≤120s). */
const CONTEXT_TTL_SECONDS = 60;

/**
 * Gateway side of the wiolett-core/v1 request context: mints the signed
 * claims a proxied data-plane request carries. The core validates signature,
 * expiry, and nonce replay before any upstream dispatch; a nonce is consumed
 * on first use, so every request (and every WebSocket turn) needs a fresh one.
 */
export function newCoreRequestContext(input: {
  tenantUserId: string;
  publicModelId: string;
  coreAccountId: string;
  coreModelId: string;
  operation: string;
  rootRequestId?: string;
  parentAttemptId?: string | null;
}): { rootRequestId: string; claims: InferenceCoreRequestContext } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const rootRequestId = input.rootRequestId ?? randomUUID();
  return {
    rootRequestId,
    claims: {
      contractId: WIOLETT_CORE_CONTRACT_ID,
      tenantUserId: input.tenantUserId,
      rootRequestId,
      parentAttemptId: input.parentAttemptId ?? null,
      publicModelId: input.publicModelId,
      coreAccountId: input.coreAccountId,
      coreModelId: input.coreModelId,
      operation: input.operation,
      issuedAt,
      expiresAt: issuedAt + CONTEXT_TTL_SECONDS,
      nonce: randomBytes(16).toString('base64url'),
    },
  };
}

/** HMAC-SHA256 over the verbatim base64url context payload — mirrors the core verifier. */
export function signCoreContext(contextB64: string, dataCredential: string): string {
  return createHmac('sha256', dataCredential).update(contextB64).digest('base64url');
}

/**
 * Headers injected on a proxied data-plane request: the core data credential
 * plus the signed context. Client-supplied copies are stripped upstream of
 * this point, so these values are always Gateway-issued.
 */
export function coreRequestHeaders(
  claims: InferenceCoreRequestContext,
  dataCredential: string
): Record<string, string> {
  const context = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    [INFERENCE_CORE_CONTEXT_HEADERS.contract]: WIOLETT_CORE_CONTRACT_ID,
    [INFERENCE_CORE_CONTEXT_HEADERS.context]: context,
    [INFERENCE_CORE_CONTEXT_HEADERS.signature]: signCoreContext(context, dataCredential),
    'x-opencodex-api-key': dataCredential,
  };
}
