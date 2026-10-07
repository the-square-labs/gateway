import { describe, expect, it } from 'vitest';
import {
  assertDockerMountChangeAllowed,
  containerRecreateChangesWorkload,
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

  it('allows creating with a managed volume with view access to it, without mount scope', () => {
    expect(() =>
      assertDockerMountChangeAllowed({
        nodeId: 'node-1',
        actorScopes: ['docker:volumes:view:node-1/app-data'],
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

  describe('attaching a managed volume', () => {
    const appData = { volumes: [{ name: 'app-data', containerPath: '/data' }] };

    it('needs view access to that volume, which mount scope does not replace', () => {
      for (const actorScopes of [
        ['docker:containers:create:node-1', 'docker:containers:mounts:node-1'],
        ['docker:volumes:view:node-1/other-team-data'],
        ['docker:volumes:view:node-2'],
      ]) {
        expect(() =>
          assertDockerMountChangeAllowed({ nodeId: 'node-1', actorScopes, currentDefinitions: [], nextConfig: appData })
        ).toThrowError(/Attaching volume "app-data" requires docker:volumes:view/);
      }
      for (const actorScopes of [
        ['docker:volumes:view'],
        ['docker:volumes:view:node-1'],
        ['docker:volumes:edit:node-1/app-data'],
      ]) {
        expect(() =>
          assertDockerMountChangeAllowed({ nodeId: 'node-1', actorScopes, currentDefinitions: [], nextConfig: appData })
        ).not.toThrow();
      }
    });

    it('checks only newly attached volumes, and not the volumes the operation creates itself', () => {
      const attached = normalizeMountDefinitionsFromConfig(appData);
      expect(() =>
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          resourceId: 'container-1',
          actorScopes: ['docker:containers:edit:node-1/container-1'],
          currentDefinitions: attached,
          nextConfig: { volumes: [...appData.volumes, { name: 'cache', containerPath: '/cache' }] },
        })
      ).toThrowError(/Attaching volume "cache"/);
      expect(() =>
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          actorScopes: [],
          currentDefinitions: attached,
          nextConfig: { volumes: [] },
        })
      ).not.toThrow();
      expect(() =>
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          actorScopes: [],
          currentDefinitions: [],
          nextConfig: appData,
          createdVolumes: ['app-data'],
        })
      ).not.toThrow();
    });
  });

  describe('a recreate that keeps the image and the mounts', () => {
    const hostBind = normalizeMountDefinitionsFromConfig({
      mounts: [{ hostPath: '/srv/app/config', containerPath: '/config', readOnly: false }],
    });

    it('needs no mounts scope from anyone when only environment, labels or link networks change', () => {
      expect(
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          resourceId: 'deployment-1',
          actorScopes: [],
          currentDefinitions: hostBind,
          nextConfig: { mounts: [{ hostPath: '/srv/app/config', containerPath: '/config', readOnly: false }] },
          workloadChanged: false,
        })
      ).toEqual({ mountsChanged: false });
    });

    it('still needs the mounts scope for another image, and when the workload change is not stated', () => {
      for (const workloadChanged of [true, undefined]) {
        expect(() =>
          assertDockerMountChangeAllowed({
            nodeId: 'node-1',
            resourceId: 'deployment-1',
            actorScopes: ['docker:containers:manage:node-1'],
            currentDefinitions: hostBind,
            nextDefinitions: hostBind,
            workloadChanged,
          })
        ).toThrowError(/Changing the image, command or runtime .* requires docker:containers:mounts/);
      }
      expect(
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          resourceId: 'deployment-1',
          actorScopes: ['docker:containers:mounts:node-1/deployment-1'],
          currentDefinitions: hostBind,
          nextDefinitions: hostBind,
          workloadChanged: true,
        })
      ).toEqual({ mountsChanged: false });
    });

    it('still needs the mounts scope when the mounts themselves change', () => {
      expect(() =>
        assertDockerMountChangeAllowed({
          nodeId: 'node-1',
          actorScopes: [],
          currentDefinitions: hostBind,
          nextConfig: { mounts: [] },
          workloadChanged: false,
        })
      ).toThrowError(/Changing Docker container or deployment mounts/);
    });

    it('treats only environment, labels, networks and mounts as leaving a container recreate on its image', () => {
      expect(containerRecreateChangesWorkload({ env: { A: '1' }, labels: { team: 'a' }, networks: ['app'] })).toBe(
        false
      );
      expect(containerRecreateChangesWorkload({ env: { A: '1' }, image: undefined })).toBe(false);
      // The same image reference can pull other code, and a command or restart change is not a link change.
      expect(containerRecreateChangesWorkload({ image: 'nginx:latest' })).toBe(true);
      expect(containerRecreateChangesWorkload({ env: { A: '1' }, command: ['sh'] })).toBe(true);
      expect(containerRecreateChangesWorkload({ restartPolicy: 'always' })).toBe(true);
    });
  });
});
