import { describe, expect, it } from 'vitest';
import { DockerSourceResourceCreateSchema } from './docker-build.schemas.js';

const source = {
  connectorId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  branch: 'main',
  dockerfilePath: 'Dockerfile',
  contextPath: '.',
  autoBuild: true,
  autoDeploy: true,
  buildArgs: {},
  buildSecretNames: [],
  policy: {},
};

describe('Docker source resource creation', () => {
  it('accepts the bounded container configuration used for the first immutable build', () => {
    expect(
      DockerSourceResourceCreateSchema.parse({
        source,
        resource: {
          kind: 'container',
          name: 'payments-api',
          restartPolicy: 'unless-stopped',
          runtimeProfile: 'secure',
        },
      })
    ).toMatchObject({ resource: { kind: 'container', name: 'payments-api', runtimeProfile: 'secure' } });
  });

  it('accepts the bounded blue-green configuration', () => {
    expect(
      DockerSourceResourceCreateSchema.parse({
        source,
        resource: {
          kind: 'deployment',
          name: 'payments-api',
          routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }],
          health: {},
          drainSeconds: 30,
          restartPolicy: 'unless-stopped',
          runtimeProfile: 'default',
        },
      })
    ).toMatchObject({ resource: { kind: 'deployment', name: 'payments-api', routerImage: 'nginx:alpine' } });
  });

  it.each([
    ['image', 'attacker.example/override:latest'],
    ['mounts', [{ hostPath: '/var/run/docker.sock', containerPath: '/host/docker.sock' }]],
    ['env', { SECRET: 'inline-value' }],
    ['gpu', { deviceIds: ['all'] }],
  ])('rejects unsupported deployment field %s instead of silently broadening the create contract', (field, value) => {
    const result = DockerSourceResourceCreateSchema.safeParse({
      source,
      resource: {
        kind: 'deployment',
        name: 'payments-api',
        routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }],
        [field]: value,
      },
    });

    expect(result.success).toBe(false);
  });
});
