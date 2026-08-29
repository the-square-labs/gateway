import { describe, expect, it } from 'vitest';
import { OAuthClientRegistrationSchema, OAuthTokenRequestSchema } from '@/modules/oauth/oauth.schemas.js';

const validRegistration = {
  redirect_uris: ['https://client.example.com/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'Gateway CLI',
};

describe('OAuthClientRegistrationSchema', () => {
  it('accepts bounded public client metadata', () => {
    const result = OAuthClientRegistrationSchema.safeParse(validRegistration);

    expect(result.success).toBe(true);
  });

  it('rejects oversized redirect URI arrays', () => {
    const result = OAuthClientRegistrationSchema.safeParse({
      ...validRegistration,
      redirect_uris: Array.from({ length: 11 }, (_, index) => `https://client.example.com/callback/${index}`),
    });

    expect(result.success).toBe(false);
  });

  it('rejects unsupported grant and response types', () => {
    const result = OAuthClientRegistrationSchema.safeParse({
      ...validRegistration,
      grant_types: ['client_credentials'],
      response_types: ['token'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects unsafe metadata URL schemes', () => {
    const result = OAuthClientRegistrationSchema.safeParse({
      ...validRegistration,
      client_uri: 'javascript:alert(1)',
      logo_uri: 'data:image/svg+xml;base64,PHN2Zy8+',
      tos_uri: 'ftp://client.example.com/tos',
      policy_uri: 'file:///tmp/policy',
    });

    expect(result.success).toBe(false);
  });
});

describe('OAuthTokenRequestSchema', () => {
  it('validates PKCE verifier length and character set', () => {
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        client_id: 'goc_client',
        code: 'code',
        redirect_uri: 'https://client.example.com/callback',
        code_verifier: 'a'.repeat(43),
      }).success
    ).toBe(true);

    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        client_id: 'goc_client',
        code_verifier: 'short',
      }).success
    ).toBe(false);

    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        client_id: 'goc_client',
        code_verifier: `${'a'.repeat(42)}!`,
      }).success
    ).toBe(false);
  });
});
