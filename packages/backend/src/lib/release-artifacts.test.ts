import { describe, expect, it } from 'vitest';
import { releaseArtifactSource, releaseFileSource, releaseNotes, releaseUrl } from './release-artifacts.js';

describe('release artifact providers', () => {
  it('builds provider-neutral GitHub release facade URLs', () => {
    expect(
      releaseFileSource('https://updates.thesqlabs.com/gateway/', 'gateway', 'v2.9.11', 'gateway-image.update.json')
    ).toEqual({
      url: 'https://updates.thesqlabs.com/gateway/gateway/v2.9.11/gateway-image.update.json',
      trustedPrefix: 'https://updates.thesqlabs.com/gateway/',
    });
    expect(
      releaseArtifactSource(
        'https://updates.thesqlabs.com/gateway',
        'nginx-daemon',
        'v2.9.11-nginx',
        'nginx-daemon-linux-amd64'
      )
    ).toEqual({
      artifactUrl: 'https://updates.thesqlabs.com/gateway/nginx-daemon/v2.9.11-nginx/nginx-daemon-linux-amd64',
      manifestUrl:
        'https://updates.thesqlabs.com/gateway/nginx-daemon/v2.9.11-nginx/nginx-daemon-linux-amd64.update.json',
      trustedPrefix: 'https://updates.thesqlabs.com/gateway/',
    });
  });

  it('normalizes release metadata', () => {
    expect(releaseNotes({ tag_name: 'v1.0.0', body: 'GitHub notes' })).toBe('GitHub notes');
    expect(releaseUrl({ tag_name: 'v1.0.0', html_url: 'https://github/release' })).toBe('https://github/release');
  });
});
