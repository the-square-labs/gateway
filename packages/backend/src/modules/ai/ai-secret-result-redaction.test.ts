import { describe, expect, it } from 'vitest';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

describe('redactOneTimeSecretToolResult', () => {
  it('redacts one-time API token secrets from persistence/model copies', () => {
    expect(
      redactOneTimeSecretToolResult('manage_api_token', {
        id: 'token-1',
        name: 'Deploy',
        scopes: ['nodes:details'],
        token: 'gw_secret',
      })
    ).toEqual({
      id: 'token-1',
      name: 'Deploy',
      scopes: ['nodes:details'],
      token: '[REDACTED_ONE_TIME_SECRET]',
      tokenRedacted: true,
    });
    expect(
      redactOneTimeSecretToolResult('manage_inference_token', {
        id: 'inference-token-1',
        tokenPrefix: 'gwi_12345678',
        token: 'gwi_secret',
      })
    ).toEqual({
      id: 'inference-token-1',
      tokenPrefix: 'gwi_12345678',
      token: '[REDACTED_ONE_TIME_SECRET]',
      tokenRedacted: true,
    });
  });

  it('leaves normal user-owned content and non-secret tool output unchanged', () => {
    const userContent = { content: 'my token-like note should stay searchable' };
    expect(redactOneTimeSecretToolResult('search_chats', userContent)).toBe(userContent);
    expect(redactOneTimeSecretToolResult('manage_api_token', { id: 'token-1', name: 'Deploy' })).toEqual({
      id: 'token-1',
      name: 'Deploy',
    });
  });

  it('redacts GitLab one-time secret tool results recursively', () => {
    expect(
      redactOneTimeSecretToolResult('gitlab_create_deploy_token', {
        id: 'deploy-token-1',
        name: 'CI',
        token: 'raw-deploy-token',
        variable: { key: 'SECRET_TOKEN', value: 'raw-variable-value' },
      })
    ).toEqual({
      id: 'deploy-token-1',
      name: 'CI',
      token: '[REDACTED_ONE_TIME_SECRET]',
      tokenRedacted: true,
      variable: {
        key: 'SECRET_TOKEN',
        value: '[REDACTED_ONE_TIME_SECRET]',
        valueRedacted: true,
        secretResultRedacted: true,
      },
      secretResultRedacted: true,
    });
  });

  it('preserves safe GitLab secret metadata while redacting raw values', () => {
    expect(
      redactOneTimeSecretToolResult('gitlab_create_deploy_token', {
        credentialId: 'credential-1',
        tokenMasked: '****abcd',
        tokenLast4: 'abcd',
        valueHash: 'sha256-hash',
        token: 'raw-token',
      })
    ).toEqual({
      credentialId: 'credential-1',
      tokenMasked: '****abcd',
      tokenLast4: 'abcd',
      valueHash: 'sha256-hash',
      token: '[REDACTED_ONE_TIME_SECRET]',
      tokenRedacted: true,
      secretResultRedacted: true,
    });
  });
});
