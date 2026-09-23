import { randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'gw_node';
const TOKEN_VERSION = 'v2';
const SELECTOR_BYTES = 8;
const SECRET_BYTES = 24;
const SELECTOR_RE = /^[0-9a-f]{16}$/;
const SECRET_RE = /^[0-9a-f]{48}$/;
const LEGACY_TOKEN_RE = /^gw_node_[0-9a-f]{48}$/;

/** Enrollment tokens are single use and expire after this long if unused. */
export const NODE_ENROLLMENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NodeEnrollmentToken {
  token: string;
  selector: string;
}

export function nodeEnrollmentTokenExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + NODE_ENROLLMENT_TOKEN_TTL_MS);
}

/** A NULL expiry is a token issued before expiries existed; it never expires. */
export function isNodeEnrollmentTokenExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

export type ParsedNodeEnrollmentToken = { kind: 'v2'; selector: string } | { kind: 'legacy' } | { kind: 'invalid' };

export function createNodeEnrollmentToken(): NodeEnrollmentToken {
  const selector = randomBytes(SELECTOR_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('hex');

  return {
    selector,
    token: `${TOKEN_PREFIX}_${TOKEN_VERSION}_${selector}_${secret}`,
  };
}

export function parseNodeEnrollmentToken(token: string): ParsedNodeEnrollmentToken {
  const trimmed = token.trim();
  const v2Prefix = `${TOKEN_PREFIX}_${TOKEN_VERSION}_`;

  if (trimmed.startsWith(v2Prefix)) {
    const parts = trimmed.slice(v2Prefix.length).split('_');
    if (parts.length !== 2) {
      return { kind: 'invalid' };
    }

    const [selector, secret] = parts;
    if (!SELECTOR_RE.test(selector) || !SECRET_RE.test(secret)) {
      return { kind: 'invalid' };
    }

    return { kind: 'v2', selector };
  }

  if (LEGACY_TOKEN_RE.test(trimmed)) {
    return { kind: 'legacy' };
  }

  return { kind: 'invalid' };
}
