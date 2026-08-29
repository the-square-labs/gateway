import { describe, expect, it } from 'vitest';
import {
  assertDockerMountChangeAllowed,
  normalizeMountDefinitionsFromConfig,
  normalizeMountDefinitionsFromInspect,
} from './docker-socket-mount.guard.js';

describe('Docker mount scope guard', () => {
  it('requires docker:containers:mounts when creating with any mount definition', () => {
    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:create:node-1'],
        currentDefinitions: [],
        nextConfig: { mounts: [{ hostPath: '/srv/app/config', containerPath: '/config' }] },
      })
    ).toThrowError(/docker:containers:mounts/);
  });

  it('allows creating with mounts when the actor has mount scope', () => {
    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:mounts:node-1'],
        currentDefinitions: [],
        nextConfig: { volumes: [{ name: 'app-data', containerPath: '/data' }] },
      })
    ).not.toThrow();
  });

  it('does not hardcode host path deny rules once the actor has mount scope', () => {
    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:mounts:node-1'],
        currentDefinitions: [],
        nextConfig: { mounts: [{ hostPath: '/var/run/docker.sock', containerPath: '/docker.sock' }] },
      })
    ).not.toThrow();
  });

  it('requires mount scope when duplicating a mounted source container', () => {
    const sourceDefinitions = normalizeMountDefinitionsFromInspect({
      Mounts: [{ Type: 'bind', Source: '/srv/app/config', Destination: '/config', RW: true }],
    });

    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:create:node-1'],
        currentDefinitions: [],
        nextDefinitions: sourceDefinitions,
      })
    ).toThrowError(/docker:containers:mounts/);
  });

  it('requires mount scope when an image update preserves a host bind mount', () => {
    const currentDefinitions = normalizeMountDefinitionsFromInspect({
      Mounts: [{ Type: 'bind', Source: '/srv/app/config', Destination: '/config', RW: false }],
    });

    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:edit:node-1'],
        currentDefinitions,
        nextConfig: { image: 'nginx:latest' } as never,
        useCurrentWhenNextMissing: true,
      })
    ).toThrowError(/docker:containers:mounts/);
  });

  it('allows recreates that preserve equivalent bind and volume definitions with mount scope', () => {
    const currentDefinitions = normalizeMountDefinitionsFromInspect({
      Mounts: [
        { Type: 'bind', Source: '/srv/app/config', Destination: '/config', RW: false },
        { Type: 'volume', Name: 'app-data', Destination: '/data', RW: true },
      ],
    });
    const nextDefinitions = normalizeMountDefinitionsFromConfig({
      mounts: [
        { hostPath: '/srv/app/config', containerPath: '/config', readOnly: true },
        { name: 'app-data', containerPath: '/data', readOnly: false },
      ],
    });

    expect(
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:manage:node-1', 'docker:containers:mounts:node-1'],
        currentDefinitions,
        nextConfig: {},
        currentInspect: null,
        useCurrentWhenNextMissing: true,
      })
    ).toEqual({ mountsChanged: false });
    expect(currentDefinitions).toEqual(nextDefinitions);
  });

  it('requires mount scope when source, target, mode, or volume name changes', () => {
    const currentDefinitions = normalizeMountDefinitionsFromConfig({
      mounts: [{ hostPath: '/srv/app/config', containerPath: '/config', readOnly: true }],
    });

    for (const nextConfig of [
      { mounts: [{ hostPath: '/srv/other/config', containerPath: '/config', readOnly: true }] },
      { mounts: [{ hostPath: '/srv/app/config', containerPath: '/settings', readOnly: true }] },
      { mounts: [{ hostPath: '/srv/app/config', containerPath: '/config', readOnly: false }] },
      { mounts: [{ name: 'app-data', containerPath: '/config', readOnly: true }] },
    ]) {
      expect(() =>
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          actorScopes: ['docker:containers:manage:node-1'],
          currentDefinitions,
          nextConfig,
        })
      ).toThrowError(/docker:containers:mounts/);
    }
  });

  it('treats unmodeled bind options as part of the mount definition', () => {
    const currentDefinitions = normalizeMountDefinitionsFromInspect({
      HostConfig: { Binds: ['/srv/app/config:/config:ro,z'] },
      Mounts: [{ Type: 'bind', Source: '/srv/app/config', Destination: '/config', RW: false }],
    });

    expect(
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:manage:node-1', 'docker:containers:mounts:node-1'],
        currentDefinitions,
        nextConfig: { image: 'nginx:latest' } as never,
        useCurrentWhenNextMissing: true,
      })
    ).toEqual({ mountsChanged: false });

    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:containers:manage:node-1'],
        currentDefinitions,
        nextConfig: { mounts: [{ hostPath: '/srv/app/config', containerPath: '/config', readOnly: true }] },
      })
    ).toThrowError(/docker:containers:mounts/);
  });
});
