import { describe, expect, it } from 'vitest';
import { __testOnly, antigravityRequest, unwrapAntigravityPayload } from './inference-antigravity.js';

describe('Google Antigravity wire helpers', () => {
  it('extracts a Cloud Code Assist project from load and onboarding payloads', () => {
    expect(__testOnly.extractProject({ cloudaicompanionProject: 'project-a' })).toBe('project-a');
    expect(__testOnly.extractProject({ response: { project: { id: 'project-b' } } })).toBe('project-b');
  });

  it('wraps the Gemini request and fails closed without a discovered project', () => {
    const wrapped = antigravityRequest(
      { accessToken: 'token', projectId: 'project-a' },
      'gemini-3.5-flash',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      'thread-a'
    );
    expect(wrapped.path).toBe('/v1internal:streamGenerateContent?alt=sse');
    expect(wrapped.body).toMatchObject({
      model: 'gemini-3.5-flash',
      project: 'project-a',
      request: { sessionId: 'thread-a' },
    });
    expect(() => antigravityRequest({ accessToken: 'token' }, 'gemini', {}, undefined)).toThrow(/project is missing/i);
  });

  it('unwraps Cloud Code Assist streaming envelopes', () => {
    expect(unwrapAntigravityPayload({ response: { candidates: [] } })).toEqual({ candidates: [] });
  });
});
