import { describe, expect, it } from 'vitest';
import {
  OAuthAuthorizationScopesSchema,
  OAuthAuthorizeQuerySchema,
  OAuthClientRegistrationSchema,
  OAuthConsentDecisionSchema,
  OAuthTokenRequestSchema,
} from '@/modules/oauth/oauth.schemas.js';

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

describe('OAuthConsentDecisionSchema', () => {
  const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

  it('accepts folder, node, and Docker container targets', () => {
    const result = OAuthConsentDecisionSchema.safeParse({
      scopes: [
        `docker:containers:manage:folder/${folderId}`,
        'docker:containers:view:node-1/container-1',
        'proxy:create:node/node-1',
        'nodes:details:node-1',
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a folder target on a base that is not folder-scopable', () => {
    expect(OAuthConsentDecisionSchema.safeParse({ scopes: [`pki:cert:view:folder/${folderId}`] }).success).toBe(false);
    expect(OAuthConsentDecisionSchema.safeParse({ scopes: ['proxy:view:folder/not-a-uuid'] }).success).toBe(false);
    expect(OAuthConsentDecisionSchema.safeParse({ scopes: ['unknown:scope'] }).success).toBe(false);
  });

  it('applies the same rules to authorization edits', () => {
    expect(OAuthAuthorizationScopesSchema.safeParse({ scopes: [`proxy:view:folder/${folderId}`] }).success).toBe(true);
    expect(OAuthAuthorizationScopesSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(OAuthAuthorizationScopesSchema.safeParse({ scopes: ['nodes:details:a/b'] }).success).toBe(false);
  });
});

describe('OAuthAuthorizeQuerySchema', () => {
  it('caps the scope parameter', () => {
    const query = {
      response_type: 'code',
      client_id: 'goc_client',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    };
    expect(OAuthAuthorizeQuerySchema.safeParse({ ...query, scope: 'proxy:view '.repeat(1000) }).success).toBe(true);
    expect(OAuthAuthorizeQuerySchema.safeParse({ ...query, scope: 'x'.repeat(16 * 1024 + 1) }).success).toBe(false);
  });
});
