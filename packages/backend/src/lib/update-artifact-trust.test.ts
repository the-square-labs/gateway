import { describe, expect, it } from 'vitest';
import {
  normalizeGitLabApiUrl,
  trustedGitLabPackagePrefix,
  UpdateArtifactTrustError,
  isDigestPinnedImageRef,
  verifyDaemonUpdateManifest,
  verifyGatewayImageManifest,
} from './update-artifact-trust.js';

const checksum = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const daemonUrl =
  'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64';
const daemonManifest = `{
  "schemaVersion": 1,
  "keyId": "wiolett-update-v1",
  "payload": "eyJraW5kIjoiZGFlbW9uLWJpbmFyeSIsInZlcnNpb24iOiJ2OS45LjkiLCJ0YWciOiJ2OS45LjktbmdpbngiLCJkYWVtb25UeXBlIjoibmdpbngiLCJhcmNoIjoiYW1kNjQiLCJhcnRpZmFjdE5hbWUiOiJuZ2lueC1kYWVtb24tbGludXgtYW1kNjQiLCJkb3dubG9hZFVybCI6Imh0dHBzOi8vZ2l0bGFiLndpb2xldHQubmV0L2FwaS92NC9wcm9qZWN0cy93aW9sZXR0JTJGZ2F0ZXdheS9wYWNrYWdlcy9nZW5lcmljL25naW54LWRhZW1vbi92OS45LjktbmdpbngvbmdpbngtZGFlbW9uLWxpbnV4LWFtZDY0Iiwic2hhMjU2IjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMDJUMTQ6Mzk6MDNaIiwiZ2l0Q29tbWl0U2hhIjoidGVzdCIsImdpdFBpcGVsaW5lSWQiOiIxIn0",
  "signature": "sNy92HOZyOUMyGJkXQ1nRmTSFm3BosuaAUaInP_Svo0cWGx50jvMlnsfU64FyubGDXK4ihvpgtlcNCfqN61ABw"
}`;
const gatewayManifest = `{
  "schemaVersion": 1,
  "keyId": "wiolett-update-v1",
  "payload": "eyJjcmVhdGVkQXQiOiIyMDI2LTA1LTAyVDE0OjM5OjEwWiIsImRpZ2VzdCI6InNoYTI1NjowMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmIiwiZ2l0Q29tbWl0U2hhIjoidGVzdCIsImdpdFBpcGVsaW5lSWQiOiIxIiwiaW1hZ2UiOiJyZWdpc3RyeS5naXRsYWIud2lvbGV0dC5uZXQvd2lvbGV0dC9nYXRld2F5IiwiaW1hZ2VSZWYiOiJyZWdpc3RyeS5naXRsYWIud2lvbGV0dC5uZXQvd2lvbGV0dC9nYXRld2F5QHNoYTI1NjowMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmIiwia2luZCI6ImdhdGV3YXktaW1hZ2UiLCJ0YWciOiJ2OS45LjkiLCJ2ZXJzaW9uIjoidjkuOS45In0",
  "signature": "XzPUEo8jVZHkeKwTqkrRQ0NqcOPj39TOPUwxTGXJ686Z7-R1UHhjZu67ROl2GZemuk77tY-t2dD1T8EH1bxEDw"
}`;

describe('update artifact trust', () => {
  it('normalizes GitLab API base URLs for exact signed URL comparisons', () => {
    expect(normalizeGitLabApiUrl('https://gitlab.wiolett.net/')).toBe('https://gitlab.wiolett.net');
    expect(trustedGitLabPackagePrefix('https://gitlab.wiolett.net/', 'wiolett/gateway')).toBe(
      'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/'
    );
  });

  it('verifies a daemon update manifest for the expected artifact', () => {
    const artifact = verifyDaemonUpdateManifest(daemonManifest, {
      daemonType: 'nginx',
      version: 'v9.9.9',
      tag: 'v9.9.9-nginx',
      arch: 'amd64',
      artifactName: 'nginx-daemon-linux-amd64',
      downloadUrl: daemonUrl,
      trustedPackagePrefix: trustedGitLabPackagePrefix('https://gitlab.wiolett.net', 'wiolett/gateway'),
    });

    expect(artifact.checksum).toBe(checksum);
    expect(artifact.downloadUrl).toBe(daemonUrl);
  });

  it('rejects daemon manifests for the wrong architecture', () => {
    expect(() =>
      verifyDaemonUpdateManifest(daemonManifest, {
        daemonType: 'nginx',
        version: 'v9.9.9',
        tag: 'v9.9.9-nginx',
        arch: 'arm64',
        artifactName: 'nginx-daemon-linux-amd64',
        downloadUrl: daemonUrl,
        trustedPackagePrefix: trustedGitLabPackagePrefix('https://gitlab.wiolett.net', 'wiolett/gateway'),
      })
    ).toThrow(UpdateArtifactTrustError);
  });

  it('rejects manifests with tampered payload bytes', () => {
    const envelope = JSON.parse(daemonManifest) as { payload: string };
    envelope.payload = Buffer.from('{"kind":"daemon-binary"}').toString('base64url');

    expect(() =>
      verifyDaemonUpdateManifest(JSON.stringify(envelope), {
        daemonType: 'nginx',
        version: 'v9.9.9',
        tag: 'v9.9.9-nginx',
        arch: 'amd64',
        artifactName: 'nginx-daemon-linux-amd64',
        downloadUrl: daemonUrl,
        trustedPackagePrefix: trustedGitLabPackagePrefix('https://gitlab.wiolett.net', 'wiolett/gateway'),
      })
    ).toThrow(UpdateArtifactTrustError);
  });

  it('verifies a gateway image manifest with a digest-pinned image reference', () => {
    const artifact = verifyGatewayImageManifest(gatewayManifest, {
      version: 'v9.9.9',
      tag: 'v9.9.9',
      image: 'registry.gitlab.wiolett.net/wiolett/gateway',
    });

    expect(artifact.imageRef).toBe(`registry.gitlab.wiolett.net/wiolett/gateway@sha256:${checksum}`);
  });

  it('rejects gateway manifests for a different image repository', () => {
    expect(() =>
      verifyGatewayImageManifest(gatewayManifest, {
        version: 'v9.9.9',
        tag: 'v9.9.9',
        image: 'registry.example.com/wiolett/gateway',
      })
    ).toThrow(UpdateArtifactTrustError);
  });

  it('accepts only a digest-pinned connector image in the Gateway repository', () => {
    const repository = 'registry.gitlab.wiolett.net/wiolett/gateway/database-connector';
    expect(isDigestPinnedImageRef(`${repository}@sha256:${checksum}`, repository)).toBe(true);
    expect(isDigestPinnedImageRef(`${repository}:v2.5.0`, repository)).toBe(false);
    expect(isDigestPinnedImageRef(`registry.example.com/connector@sha256:${checksum}`, repository)).toBe(false);
  });
});
