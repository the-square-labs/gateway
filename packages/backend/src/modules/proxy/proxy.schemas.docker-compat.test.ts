import { describe, expect, it } from 'vitest';
import { CreateProxyHostSchema } from './proxy.schemas.js';

const base = {
  type: 'proxy' as const,
  nodeId: '11111111-1111-4111-8111-111111111111',
  domainNames: ['app.example.com'],
  upstreamKind: 'docker_container' as const,
  forwardScheme: 'http' as const,
  dockerNodeId: '22222222-2222-4222-8222-222222222222',
  dockerContainerPort: 8080,
  dockerProtocol: 'tcp' as const,
};

describe('CreateProxyHostSchema Docker client compatibility', () => {
  it('accepts an older standalone-container payload with null Compose fields', () => {
    const result = CreateProxyHostSchema.safeParse({
      ...base,
      dockerContainerName: 'gateway-license-server',
      dockerComposeProjectId: null,
      dockerComposeServiceName: null,
    });

    expect(result.success).toBe(true);
  });

  it('accepts an older Compose payload with a null standalone-container field', () => {
    const result = CreateProxyHostSchema.safeParse({
      ...base,
      dockerContainerName: null,
      dockerComposeProjectId: '33333333-3333-4333-8333-333333333333',
      dockerComposeServiceName: 'license-server',
    });

    expect(result.success).toBe(true);
  });

  it('still rejects a Docker target without either complete identity', () => {
    const result = CreateProxyHostSchema.safeParse({
      ...base,
      dockerContainerName: null,
      dockerComposeProjectId: null,
      dockerComposeServiceName: null,
    });

    expect(result.success).toBe(false);
  });
});
