import { describe, expect, it } from 'vitest';
import { containerUpdateChangesImage, containerUpdateRequiredScopes } from './docker-container-scope-requirements.js';

describe('container update scopes', () => {
  it('treats a new tag like a recreate with a new image: edit, environment and secrets, which also cover the pull', () => {
    expect(containerUpdateRequiredScopes({ tag: 'attacker-build' })).toEqual([
      'docker:containers:edit',
      'docker:containers:environment',
      'docker:containers:secrets',
    ]);
    expect(containerUpdateChangesImage({ tag: 'attacker-build' })).toBe(true);
  });

  it('keeps an env-only update on environment, as the env route, and a plain redeploy on edit', () => {
    expect(containerUpdateRequiredScopes({ env: { MODE: 'debug' } })).toEqual(['docker:containers:environment']);
    expect(containerUpdateRequiredScopes({ tag: '' })).toEqual(['docker:containers:edit']);
    expect(containerUpdateChangesImage({ tag: '' })).toBe(false);
  });
});
