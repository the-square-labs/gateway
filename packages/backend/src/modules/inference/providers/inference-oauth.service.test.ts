import 'reflect-metadata';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-oauth.service.js';

function jwt(payload: object): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
}

describe('inference provider OAuth security helpers', () => {
  it('accepts pasted callback URLs and binds code to exact state', () => {
    const callback = __testOnly.parseCallback('http://localhost:1455/auth/callback?code=code-1&state=state-1');
    expect(callback).toEqual({ code: 'code-1', state: 'state-1' });
    expect(__testOnly.hashState(callback.state!)).toHaveLength(64);
    expect(__testOnly.hashState(callback.state!)).not.toBe(__testOnly.hashState('state-2'));
  });

  it('extracts account identity without exposing token contents', () => {
    const identity = __testOnly.tokenIdentity('openai', {
      accessToken: jwt({
        email: 'ADMIN@EXAMPLE.COM',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
      }),
    });
    expect(identity).toEqual({ accountId: 'acct-123', email: 'admin@example.com' });
    expect(JSON.stringify(identity)).not.toContain('eyJ');
  });

  it('combines OpenAI identity claims across id and access tokens', () => {
    const identity = __testOnly.tokenIdentity('openai', {
      idToken: jwt({ email: 'ADMIN@EXAMPLE.COM' }),
      accessToken: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } }),
    });
    expect(identity).toEqual({ accountId: 'acct-123', email: 'admin@example.com' });
  });

  it('prefers Kimi user_id over the weaker sub claim across tokens', () => {
    const identity = __testOnly.tokenIdentity('kimi', {
      accessToken: jwt({ sub: 'subject-id', email: 'KIMI@EXAMPLE.COM' }),
      refreshToken: jwt({ user_id: 'stable-user-id' }),
    });
    expect(identity).toEqual({ accountId: 'stable-user-id', email: 'kimi@example.com' });
  });
});
