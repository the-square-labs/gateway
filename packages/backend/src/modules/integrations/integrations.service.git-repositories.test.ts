import { describe, expect, it } from 'vitest';
import { githubRepositoryContentPath } from './integrations.service.git-repositories.js';

describe('githubRepositoryContentPath', () => {
  it('refuses paths that leave the granted repository once the API URL is parsed', () => {
    for (const path of [
      '../../../../user/repos',
      'docs/../../../other-owner/other-repo/contents',
      '%2e%2e/%2e%2e/%2e%2e/%2e%2e/repos/victim/secret/contents/a',
      '%2E./%2e%2E/x',
      'a%00b',
      '%E0%A4%A',
    ]) {
      expect(() => githubRepositoryContentPath(path, { required: false })).toThrow(/must be relative/);
    }
    expect(() => githubRepositoryContentPath('', { required: true })).toThrow(/must be relative/);
  });

  it('keeps ordinary repository paths, and the root for a listing', () => {
    expect(githubRepositoryContentPath('/src/app.ts', { required: true })).toBe('src/app.ts');
    expect(githubRepositoryContentPath(undefined, { required: false })).toBe('');
  });
});
