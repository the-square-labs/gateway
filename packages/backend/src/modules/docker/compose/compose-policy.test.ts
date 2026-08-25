import { describe, expect, it } from 'vitest';
import { prepareComposeGitBuild, validateComposeYaml } from './compose-policy.js';

describe('validateComposeYaml', () => {
  it('accepts the image-only safe subset and reports normalized resources', () => {
    const result = validateComposeYaml({
      projectName: 'demo',
      variables: { TAG: '1.0' },
      secretKeys: ['PASSWORD'],
      yaml: `services:
  api:
    image: example/api:\${TAG}
    environment:
      PASSWORD: \${PASSWORD}
    cpus: 1.5
    cpu_shares: 512
    mem_limit: 768M
    mem_reservation: 256M
    memswap_limit: 1G
    pids_limit: 128
    ports:
      - "8080:80"
    volumes:
      - data:/var/lib/app
    networks: [frontend]
volumes:
  data: {}
networks:
  frontend: {}
`,
    });

    expect(result.valid).toBe(true);
    expect(result.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.normalizedModel?.services.api).toMatchObject({
      image: `example/api:\${TAG}`,
      cpus: 1.5,
      cpuShares: 512,
      memoryLimit: '768M',
      memoryReservation: '256M',
      memorySwapLimit: '1G',
      pidsLimit: 128,
      ports: [{ published: 8080, target: 80, protocol: 'tcp' }],
      volumes: [{ source: 'data', target: '/var/lib/app', readOnly: false, external: false }],
    });
  });

  it('rejects invalid ordinary resource limits while keeping deploy unsupported', () => {
    const result = validateComposeYaml({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:
  api:
    image: example/api:latest
    cpus: -0.1
    mem_limit: lots
    pids_limit: 0
    deploy:
      resources:
        limits:
          memory: 1G
`,
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['INVALID_RESOURCE_LIMIT', 'UNSUPPORTED_SERVICE_FIELD'])
    );
  });

  it('rejects build even when image is present', () => {
    const result = validateComposeYaml({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:
  api:
    image: example/api:latest
    build: .
`,
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'BUILD_FORBIDDEN' })]));
  });

  it('prepares repository Compose builds as image-only runtime YAML', () => {
    const result = prepareComposeGitBuild(
      {
        projectName: 'demo',
        variables: {},
        secretKeys: [],
        yaml: `services:
  api:
    build:
      context: services/api
      dockerfile: Dockerfile.prod
      args:
        NODE_ENV: production
    ports: ["8080:80"]
  worker:
    build: services/worker
  redis:
    image: redis:7-alpine
`,
      },
      {
        api: `127.0.0.1:5443/gateway/builds/source/api@sha256:${'a'.repeat(64)}`,
        worker: `127.0.0.1:5443/gateway/builds/source/worker@sha256:${'b'.repeat(64)}`,
      }
    );

    expect(result.valid).toBe(true);
    expect(result.services).toEqual([
      {
        serviceName: 'api',
        contextPath: 'services/api',
        dockerfilePath: 'services/api/Dockerfile.prod',
        buildArgs: { NODE_ENV: 'production' },
      },
      {
        serviceName: 'worker',
        contextPath: 'services/worker',
        dockerfilePath: 'services/worker/Dockerfile',
        buildArgs: {},
      },
    ]);
    expect(result.runtimeYaml).not.toContain('build:');
    expect(result.validation.normalizedModel?.services.api.image).toContain('@sha256:');
    expect(result.validation.normalizedModel?.services.redis.image).toBe('redis:7-alpine');
  });

  it('normalizes dot-prefixed Compose contexts and resolves Dockerfiles from the context directory', () => {
    const result = prepareComposeGitBuild({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:
  web:
    build:
      context: ./web
`,
    });

    expect(result.valid).toBe(true);
    expect(result.services).toEqual([
      {
        serviceName: 'web',
        contextPath: 'web',
        dockerfilePath: 'web/Dockerfile',
        buildArgs: {},
      },
    ]);
  });

  it('rejects repository build paths that escape the checkout', () => {
    const result = prepareComposeGitBuild({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:
  api:
    build:
      context: ../api
      dockerfile: /Dockerfile
`,
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['INVALID_BUILD_CONTEXT', 'INVALID_DOCKERFILE_PATH'])
    );
  });

  it.each([
    ['external', '{}', 'INVALID_RESOURCE_EXTERNAL'],
    ['name', '[]', 'INVALID_RESOURCE_NAME'],
    ['driver', '{}', 'INVALID_RESOURCE_DRIVER'],
  ] as const)('rejects invalid resource %s types before dispatch', (field, value, code) => {
    const result = validateComposeYaml({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:\n  api:\n    image: example/api:latest\nvolumes:\n  data:\n    ${field}: ${value}\n`,
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });

  it('rejects host binds, privileged mode, aliases, and multiple documents', () => {
    const result = validateComposeYaml({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:
  api: &api
    image: example/api:latest
    privileged: true
    volumes:
      - ./data:/data
---
services: {}
`,
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['MULTIPLE_DOCUMENTS', 'UNSUPPORTED_SERVICE_FIELD', 'HOST_BIND_FORBIDDEN'])
    );
  });

  it('reports unresolved required variables without persisting expanded values', () => {
    const result = validateComposeYaml({
      projectName: 'demo',
      variables: {},
      secretKeys: [],
      yaml: `services:
  api:
    image: example/api:\${TAG}
`,
    });

    expect(result.valid).toBe(false);
    expect(result.requiredVariables).toEqual(['TAG']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'VARIABLE_REQUIRED' }));
  });
});
