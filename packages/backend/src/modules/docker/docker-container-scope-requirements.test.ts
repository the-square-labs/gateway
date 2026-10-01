import { describe, expect, it } from 'vitest';
import { containerUpdateChangesImage, containerUpdateRequiredScopes } from './docker-container-scope-requirements.js';

describe('container update scopes', () => {
  it('treats a new tag like a recreate with a new image: environment and secrets, plus an image pull', () => {
    expect(containerUpdateRequiredScopes({ tag: 'attacker-build' })).toEqual([
      'docker:containers:environment',
      'docker:containers:secrets',
    ]);
    expect(containerUpdateChangesImage({ tag: 'attacker-build' })).toBe(true);
  });

  it('keeps an env-only update on environment and a plain pull-and-redeploy on edit alone', () => {
    expect(containerUpdateRequiredScopes({ env: { MODE: 'debug' } })).toEqual(['docker:containers:environment']);
    expect(containerUpdateRequiredScopes({ tag: '' })).toEqual([]);
    expect(containerUpdateChangesImage({ tag: '' })).toBe(false);
  });
});
