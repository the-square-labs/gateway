import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertInferenceCoreTransition,
  canInferenceCoreTransition,
  INFERENCE_CORE_PROTOCOL_MAJOR,
  INFERENCE_CORE_STATE_SCHEMA_VERSION,
  INFERENCE_CORE_STATES,
  INFERENCE_CORE_TRANSITIONS,
  InferenceCoreStateTransitionError,
  inferenceCoreAdmissionRequestSchema,
  inferenceCoreAdmissionResponseSchema,
  inferenceCoreHealthIdentitySchema,
  inferenceCoreRequestContextSchema,
  inferenceCoreSettlementSchema,
  inferenceCoreStatusSchema,
  WIOLETT_CORE_CONTRACT_ID,
} from './inference-core.contract.js';

/**
 * These fixtures are duplicated into the Square Labs OpenCodex repository and are
 * protected by the same pinned hashes there. Changing a fixture without
 * updating both copies and both hash maps breaks the contract test on the side
 * that was not updated.
 */
const FIXTURE_HASHES: Record<string, string> = {
  'health-identity.json': 'aa11398475cafc462e6e0ee4bc275508ad31023f3749b51f9b87bd1b9c1429fa',
  'lifecycle-status.json': '71eec305bb23fdfd15bb3ba072f83dad66871cbdd0bd3e6117fe8738eb60ef4f',
  'admission.json': '3545d799fe572ce6cb0f7a591d0261c5af81ee4ce05081c0e4936afb7922839c',
  'settlement.json': 'bcd6527f5b02d98ef29fe78dd583729bd2303663cca05378b4d31356da15530d',
};

function readFixture(name: keyof typeof FIXTURE_HASHES): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const raw = readFileSync(path, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  expect(hash, `fixture ${name} drifted from the pinned contract hash`).toBe(FIXTURE_HASHES[name]);
  return JSON.parse(raw) as unknown;
}

describe('inference core contract constants', () => {
  it('pins the contract identity and protocol version', () => {
    expect(WIOLETT_CORE_CONTRACT_ID).toBe('wiolett-core/v1');
    expect(INFERENCE_CORE_PROTOCOL_MAJOR).toBe(1);
    expect(INFERENCE_CORE_STATE_SCHEMA_VERSION).toBe(1);
  });

  it('pins the runtime state set in a stable order', () => {
    expect(INFERENCE_CORE_STATES).toEqual([
      'not_installed',
      'resolving',
      'pulling',
      'installing',
      'starting',
      'ready',
      'update_available',
      'updating',
      'rolling_back',
      'degraded',
      'failed',
    ]);
  });
});

describe('inference core state machine', () => {
  it('covers every declared state exactly once as a transition source', () => {
    expect(Object.keys(INFERENCE_CORE_TRANSITIONS).sort()).toEqual([...INFERENCE_CORE_STATES].sort());
  });

  it('allows the install happy path', () => {
    for (const [from, to] of [
      ['not_installed', 'resolving'],
      ['resolving', 'pulling'],
      ['pulling', 'installing'],
      ['installing', 'starting'],
      ['starting', 'ready'],
    ] as const) {
      expect(canInferenceCoreTransition(from, to)).toBe(true);
      expect(() => assertInferenceCoreTransition(from, to)).not.toThrow();
    }
  });

  it('allows update, rollback, and retry paths', () => {
    for (const [from, to] of [
      ['ready', 'update_available'],
      ['update_available', 'updating'],
      ['updating', 'rolling_back'],
      ['rolling_back', 'ready'],
      ['failed', 'resolving'],
      ['failed', 'updating'],
      ['degraded', 'starting'],
    ] as const) {
      expect(canInferenceCoreTransition(from, to)).toBe(true);
    }
  });

  it('rejects illegal transitions with a typed error', () => {
    for (const [from, to] of [
      ['not_installed', 'ready'],
      ['not_installed', 'updating'],
      ['ready', 'pulling'],
      ['ready', 'not_installed'],
      ['rolling_back', 'pulling'],
      ['failed', 'ready'],
    ] as const) {
      expect(canInferenceCoreTransition(from, to)).toBe(false);
      expect(() => assertInferenceCoreTransition(from, to)).toThrow(InferenceCoreStateTransitionError);
    }
  });
});

describe('shared frozen fixtures', () => {
  it('parses the health identity fixture', () => {
    const parsed = inferenceCoreHealthIdentitySchema.parse(readFixture('health-identity.json'));
    expect(parsed.service).toBe('opencodex');
    expect(parsed.coreProtocolMajor).toBe(INFERENCE_CORE_PROTOCOL_MAJOR);
  });

  it('parses the lifecycle status fixture', () => {
    const parsed = inferenceCoreStatusSchema.parse(readFixture('lifecycle-status.json'));
    expect(parsed.state).toBe('pulling');
    expect(parsed.operation?.status).toBe('running');
  });

  it('parses the admission fixture exchange', () => {
    const fixture = readFixture('admission.json') as { request: unknown; allow: unknown; deny: unknown };
    const request = inferenceCoreAdmissionRequestSchema.parse(fixture.request);
    expect(request.attemptKind).toBe('root');
    expect(inferenceCoreAdmissionResponseSchema.parse(fixture.allow).decision).toBe('allow');
    expect(inferenceCoreAdmissionResponseSchema.parse(fixture.deny).decision).toBe('deny');
  });

  it('parses the settlement fixture', () => {
    const parsed = inferenceCoreSettlementSchema.parse(readFixture('settlement.json'));
    expect(parsed.terminalStatus).toBe('completed');
    expect(parsed.usage.outputTokens).toBeGreaterThan(0);
  });

  it('rejects a request context whose expiry does not follow issuance', () => {
    const result = inferenceCoreRequestContextSchema.safeParse({
      contractId: WIOLETT_CORE_CONTRACT_ID,
      tenantUserId: '11111111-1111-4111-8111-111111111111',
      rootRequestId: '1b4e28ba-2fa1-4d9c-8e3a-0f4f7c1a2b01',
      parentAttemptId: null,
      publicModelId: 'gateway/gpt-5.6-terra',
      coreAccountId: 'acct_openai_primary',
      coreModelId: 'openai/gpt-5.6-terra',
      operation: 'responses',
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_000,
      nonce: '0123456789abcdef',
    });
    expect(result.success).toBe(false);
  });
});
