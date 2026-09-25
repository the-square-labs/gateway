import { describe, expect, it } from 'vitest';
import { CreatePageDeploymentSchema, FinalizePageUploadSchema } from './page-deployment.schemas.js';
import { resolvePageDeploymentExpiry } from './page-deployment-expiry.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');

describe('Pages Deployment expiry', () => {
  it('keeps no expiry unless one is requested', () => {
    expect(resolvePageDeploymentExpiry({}, NOW)).toBeUndefined();
    expect(resolvePageDeploymentExpiry({ expiresAt: null }, NOW)).toBeNull();
  });

  it('resolves a lifetime in hours or an absolute time', () => {
    expect(resolvePageDeploymentExpiry({ expiresInHours: 24 }, NOW)).toEqual(new Date('2026-09-27T12:00:00.000Z'));
    expect(resolvePageDeploymentExpiry({ expiresAt: '2026-10-01T00:00:00+02:00' }, NOW)).toEqual(
      new Date('2026-09-30T22:00:00.000Z')
    );
  });

  it('rejects ambiguous, past, too-near and too-far expiries', () => {
    const invalid = [
      { expiresAt: '2026-09-27T00:00:00Z', expiresInHours: 2 },
      { expiresAt: '2026-09-26T11:00:00Z' },
      { expiresAt: '2026-09-26T12:01:00Z' },
      { expiresAt: '2027-12-01T00:00:00Z' },
      { expiresInHours: 0 },
      { expiresInHours: 24 * 365 + 1 },
    ];
    for (const input of invalid) {
      expect(() => resolvePageDeploymentExpiry(input, NOW)).toThrowError(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('accepts the upload format and expiry fields at begin and finalize', () => {
    const begin = CreatePageDeploymentSchema.parse({
      projectId: '11111111-1111-4111-8111-111111111111',
      declaredSizeBytes: 12,
      sha256: 'a'.repeat(64),
      format: 'html',
      expiresInHours: 12,
    });
    expect(begin).toMatchObject({ format: 'html', expiresInHours: 12 });
    expect(() => CreatePageDeploymentSchema.parse({ ...begin, format: 'zip' })).toThrow();
    expect(FinalizePageUploadSchema.parse({})).toEqual({});
    expect(FinalizePageUploadSchema.parse({ expiresAt: null })).toEqual({ expiresAt: null });
  });
});
