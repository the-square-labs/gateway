import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrustedOpenCodexImageArtifact } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  checkOpenCodexGatewayCompatibility,
  compareOpenCodexVersions,
  fetchLatestOpenCodexTag,
  fetchOpenCodexImageManifest,
  parseOpenCodexVersion,
} from './inference-core.manifest.js';

const IMAGE = 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex';
const DIGEST = `sha256:${'ab'.repeat(32)}`;

const signingKey = generateKeyPairSync('ed25519');
const publicKeyPem = signingKey.publicKey.export({ type: 'spki', format: 'pem' });

function signedManifest(overrides: Record<string, unknown> = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      kind: 'opencodex-image',
      version: '2.26.0-wiolett.1',
      tag: 'v2.26.0-wiolett.1',
      image: IMAGE,
      digest: DIGEST,
      imageRef: `${IMAGE}@${DIGEST}`,
      sizeBytes: 123_456_789,
      coreProtocolMajor: 1,
      stateSchemaVersion: 1,
      minGatewayVersion: 'v2.8.0',
      releaseNotesUrl: 'https://docs.wiolett.net/releases/v2.26.0-wiolett.1',
      buildRevision: 'abc123',
      createdAt: '2026-08-19T00:00:00.000Z',
      ...overrides,
    })
  );
  return JSON.stringify({
    schemaVersion: 1,
    keyId: 'wiolett-update-v1',
    payload: payload.toString('base64url'),
    signature: sign(null, payload, signingKey.privateKey).toString('base64url'),
  });
}

function stubFetch(handler: (url: string) => Response | undefined): void {
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = handler(url);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCodex release version helpers', () => {
  it('parses and compares wiolett build versions', () => {
    expect(parseOpenCodexVersion('v2.26.0-wiolett.1')).toEqual({ base: '2.26.0', build: 1 });
    expect(parseOpenCodexVersion('2.26.0')).toBeNull();
    expect(compareOpenCodexVersions('v2.26.0-wiolett.2', 'v2.26.0-wiolett.1')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('v2.26.1-wiolett.1', 'v2.26.0-wiolett.9')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('v2.26.0-wiolett.1', 'v2.26.0-wiolett.1')).toBe(0);
  });
});

describe('fetchLatestOpenCodexTag', () => {
  it('accepts provider-neutral GitHub-style release rows', async () => {
    stubFetch((url) =>
      url === 'https://updates.thesqlabs.com/gateway/releases'
        ? Response.json([{ tag_name: 'v2.26.0-wiolett.2' }, { tag_name: 'v2.27.0-wiolett.1' }])
        : undefined
    );
    await expect(fetchLatestOpenCodexTag('https://updates.thesqlabs.com/gateway/releases')).resolves.toBe(
      'v2.27.0-wiolett.1'
    );
  });

  it('returns the newest wiolett tag from GitHub Releases', async () => {
    stubFetch(() =>
      Response.json([
        { tag_name: 'v2.25.0-wiolett.3' },
        { tag_name: 'v2.26.0-wiolett.1' },
        { tag_name: 'v2.26.0-wiolett.2' },
        { tag_name: 'not-a-release' },
      ])
    );
    await expect(fetchLatestOpenCodexTag('https://updates.thesqlabs.com/gateway/releases')).resolves.toBe(
      'v2.26.0-wiolett.2'
    );
  });

  it('returns null when no wiolett release exists', async () => {
    stubFetch(() => Response.json([{ tag_name: 'v2.7.9-relay' }]));
    await expect(fetchLatestOpenCodexTag('https://updates.thesqlabs.com/gateway/releases')).resolves.toBeNull();
  });

  it('fails closed on registry errors', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    await expect(fetchLatestOpenCodexTag('https://updates.thesqlabs.com/gateway/releases')).rejects.toBeInstanceOf(
      AppError
    );
  });
});

describe('fetchOpenCodexImageManifest', () => {
  it('loads a signed manifest from the provider-neutral artifact base', async () => {
    stubFetch((url) =>
      url ===
      'https://updates.thesqlabs.com/gateway/inference-core/v2.26.0-wiolett.1/opencodex-image.update.json'
        ? new Response(signedManifest())
        : undefined
    );
    await expect(
      fetchOpenCodexImageManifest(
        'https://updates.thesqlabs.com/gateway/',
        'v2.26.0-wiolett.1',
        IMAGE,
        publicKeyPem
      )
    ).resolves.toMatchObject({ version: '2.26.0-wiolett.1', digest: DIGEST });
  });

  it('verifies and returns a signed manifest', async () => {
    stubFetch((url) => (url.includes('opencodex-image.update.json') ? new Response(signedManifest()) : undefined));
    const artifact = await fetchOpenCodexImageManifest(
      'https://updates.thesqlabs.com/gateway',
      'v2.26.0-wiolett.1',
      IMAGE,
      publicKeyPem
    );
    expect(artifact.version).toBe('2.26.0-wiolett.1');
    expect(artifact.digest).toBe(DIGEST);
    expect(artifact.imageRef).toBe(`${IMAGE}@${DIGEST}`);
    expect(artifact.sizeBytes).toBe(123_456_789);
    expect(artifact.minGatewayVersion).toBe('v2.8.0');
  });

  it('rejects a tampered signature as untrusted', async () => {
    const tampered = JSON.parse(signedManifest());
    tampered.signature = Buffer.from('forged-signature-padding-forged-signature').toString('base64url');
    stubFetch(() => new Response(JSON.stringify(tampered)));
    await expect(
      fetchOpenCodexImageManifest('https://updates.thesqlabs.com/gateway', 'v2.26.0-wiolett.1', IMAGE, publicKeyPem)
    ).rejects.toMatchObject({ statusCode: 502, code: 'UNTRUSTED_UPDATE_ARTIFACT' });
  });

  it('rejects a manifest for a different image or tag', async () => {
    stubFetch(() => new Response(signedManifest()));
    await expect(
      fetchOpenCodexImageManifest(
        'https://updates.thesqlabs.com/gateway',
        'v2.26.0-wiolett.1',
        'evil/image',
        publicKeyPem
      )
    ).rejects.toMatchObject({ code: 'UNTRUSTED_UPDATE_ARTIFACT' });
    stubFetch(() => new Response(signedManifest({ tag: 'v9.9.9-wiolett.1' })));
    await expect(
      fetchOpenCodexImageManifest('https://updates.thesqlabs.com/gateway', 'v2.26.0-wiolett.1', IMAGE, publicKeyPem)
    ).rejects.toMatchObject({ code: 'UNTRUSTED_UPDATE_ARTIFACT' });
  });

  it('rejects malformed tags before any network access', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      fetchOpenCodexImageManifest('https://updates.thesqlabs.com/gateway', 'latest', IMAGE, publicKeyPem)
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CORE_VERSION' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('checkOpenCodexGatewayCompatibility', () => {
  const artifact = {
    version: '2.26.0-wiolett.1',
    minGatewayVersion: 'v2.8.0',
    maxGatewayVersion: undefined,
  } as unknown as TrustedOpenCodexImageArtifact;

  it('accepts a gateway within the bounds and any dev build', () => {
    expect(checkOpenCodexGatewayCompatibility(artifact, '2.8.1').compatible).toBe(true);
    expect(checkOpenCodexGatewayCompatibility(artifact, '2.8.0').compatible).toBe(true);
    expect(checkOpenCodexGatewayCompatibility(artifact, 'dev').compatible).toBe(true);
  });

  it('rejects an older gateway with an actionable reason', () => {
    const result = checkOpenCodexGatewayCompatibility(artifact, '2.7.9');
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('2.8.0');
  });

  it('rejects a gateway beyond the maximum', () => {
    const bounded = { ...artifact, maxGatewayVersion: 'v2.9.0' } as TrustedOpenCodexImageArtifact;
    expect(checkOpenCodexGatewayCompatibility(bounded, '2.9.1').compatible).toBe(false);
    expect(checkOpenCodexGatewayCompatibility(bounded, '2.9.0').compatible).toBe(true);
  });
});
