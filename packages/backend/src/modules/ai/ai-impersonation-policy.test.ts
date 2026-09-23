import { describe, expect, it } from 'vitest';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { assertToolCallAllowedUnderImpersonation, isImpersonationBlockedToolCall } from './ai-impersonation-policy.js';

const impersonation = {
  actorUserId: 'admin-1',
  subjectUserId: 'user-1',
  subjectEmail: 'user@example.com',
  subjectName: 'User',
};

describe('AI impersonation policy', () => {
  it.each(['pkcs12', 'jks', 'private-key', 'pem-bundle'])('blocks a %s certificate export', (format) => {
    expect(isImpersonationBlockedToolCall('manage_certificate', { operation: 'export', format })).toBe(true);
  });

  it('allows certificate exports and operations without a private key', () => {
    expect(isImpersonationBlockedToolCall('manage_certificate', { operation: 'export', format: 'pem' })).toBe(false);
    expect(isImpersonationBlockedToolCall('manage_certificate', { operation: 'export', format: 'der' })).toBe(false);
    expect(isImpersonationBlockedToolCall('manage_certificate', { operation: 'chain', format: 'pkcs12' })).toBe(false);
  });

  it('blocks certificate issuance, which generates a private key', () => {
    expect(isImpersonationBlockedToolCall('issue_certificate', { caId: 'ca-1' })).toBe(true);
  });

  it('blocks revealing Docker secret values but not listing them masked', () => {
    const tool = 'manage_docker_container_config';
    expect(isImpersonationBlockedToolCall(tool, { operation: 'list_secrets', reveal: true })).toBe(true);
    expect(isImpersonationBlockedToolCall(tool, { operation: 'list_secrets', reveal: false })).toBe(false);
    expect(isImpersonationBlockedToolCall(tool, { operation: 'list_secrets' })).toBe(false);
    expect(isImpersonationBlockedToolCall(tool, { operation: 'get_env', reveal: true })).toBe(false);
  });

  it('refuses a blocked call only while the audit context shows impersonation', () => {
    const args = { operation: 'export', format: 'pkcs12' };
    expect(() => assertToolCallAllowedUnderImpersonation('manage_certificate', args)).not.toThrow();
    runWithAuditRequestContext({}, () => {
      expect(() => assertToolCallAllowedUnderImpersonation('manage_certificate', args)).not.toThrow();
    });
    runWithAuditRequestContext({ impersonation }, () => {
      expect(() => assertToolCallAllowedUnderImpersonation('manage_certificate', args)).toThrow(
        expect.objectContaining({ statusCode: 403, code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' })
      );
      expect(() =>
        assertToolCallAllowedUnderImpersonation('manage_certificate', { operation: 'export', format: 'pem' })
      ).not.toThrow();
    });
  });
});
