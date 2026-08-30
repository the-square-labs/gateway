import { describe, expect, it } from 'vitest';
import {
  filterGatewayInternalImages,
  gatewayInternalImageKind,
  resolveDockerImageByIdentifier,
  selectObsoleteGatewayConnectorImages,
} from './docker-internal-images.js';

describe('Gateway internal image classification', () => {
  it.each([
    ['the-square-labs/gateway/secure-link-connector@sha256:abc', 'secure-link-connector'],
    ['wiolett/gateway/database-connector@sha256:def', 'database-connector'],
    ['gateway-secure-link-connector:dev', 'secure-link-connector'],
    ['docker.io/docker/compose-bin@sha256:123', 'compose-sidecar'],
  ] as const)('recognizes %s', (reference, kind) => {
    expect(gatewayInternalImageKind({ RepoDigests: [reference] })).toBe(kind);
  });

  it('does not hide user images with similar words', () => {
    const user = { Id: 'user', RepoTags: ['acme/secure-link-dashboard:latest'] };
    const internal = {
      Id: 'internal',
      RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:abc'],
    };

    expect(filterGatewayInternalImages([user, internal])).toEqual([user]);
  });

  it('resolves equivalent full references and unique prefixed or unprefixed image IDs', () => {
    const image = {
      Id: 'sha256:abcdef1234567890',
      RepoDigests: ['docker.io/the-square-labs/gateway/secure-link-connector@sha256:abc'],
    };

    expect(
      resolveDockerImageByIdentifier(
        [image],
        'index.docker.io/the-square-labs/gateway/secure-link-connector@sha256:abc'
      )
    ).toBe(image);
    expect(resolveDockerImageByIdentifier([image], 'sha256:abcdef1234567890')).toBe(image);
    expect(resolveDockerImageByIdentifier([image], 'abcdef123456')).toBe(image);
  });

  it('removes only older unused connector images while preserving current, in-use, rollback, and Compose images', () => {
    const images = [
      {
        Id: 'current',
        RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:current'],
        Created: 500,
        Containers: 0,
        Size: 10,
      },
      {
        Id: 'rollback',
        RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:rollback'],
        Created: 400,
        Containers: 0,
        Size: 11,
      },
      {
        Id: 'obsolete',
        RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:obsolete'],
        Created: 300,
        Containers: 0,
        Size: 12,
      },
      {
        Id: 'in-use',
        RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:in-use'],
        Created: 200,
        Containers: 1,
        Size: 13,
      },
      {
        Id: 'legacy-newest',
        RepoDigests: ['wiolett/gateway/database-connector@sha256:newest'],
        Created: 200,
        Containers: 0,
        Size: 14,
      },
      {
        Id: 'legacy-old',
        RepoDigests: ['wiolett/gateway/database-connector@sha256:old'],
        Created: 100,
        Containers: 0,
        Size: 15,
      },
      {
        Id: 'compose',
        RepoDigests: ['docker.io/docker/compose-bin@sha256:compose'],
        Created: 1,
        Containers: 0,
        Size: 16,
      },
    ];

    expect(
      selectObsoleteGatewayConnectorImages(images, 'the-square-labs/gateway/secure-link-connector@sha256:current').map(
        (image) => image.id
      )
    ).toEqual(['obsolete', 'legacy-old']);
  });
});
