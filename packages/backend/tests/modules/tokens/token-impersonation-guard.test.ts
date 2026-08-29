import { describe, expect, it } from 'vitest';
import { assertTokenManagementSession } from '@/modules/tokens/tokens.routes.js';

describe('API token impersonation guard', () => {
  it('allows a normal browser session', () => {
    expect(() => assertTokenManagementSession(undefined)).not.toThrow();
  });

  it('rejects token management from an impersonation session', () => {
    expect(() => assertTokenManagementSession({ actor: { id: 'admin-1' } })).toThrowError(
      expect.objectContaining({ statusCode: 403, code: 'IMPERSONATION_TOKEN_MANAGEMENT_FORBIDDEN' })
    );
  });
});
