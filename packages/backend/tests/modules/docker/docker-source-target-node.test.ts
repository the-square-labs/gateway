import { describe, expect, it } from 'vitest';
import { assertDockerSourceTargetNode } from '@/modules/docker/docker-source.routes.js';

describe('Docker source route target-node integrity', () => {
  it.each(['compose', 'deployment'] as const)('accepts a %s target on the requested node', (resource) => {
    expect(() => assertDockerSourceTargetNode('node-1', 'node-1', resource)).not.toThrow();
  });

  it('hides a Compose project stored on another node', () => {
    expect(() => assertDockerSourceTargetNode('node-1', 'node-2', 'compose')).toThrowError(
      expect.objectContaining({ statusCode: 404, code: 'COMPOSE_PROJECT_NOT_FOUND' })
    );
  });

  it('hides a deployment stored on another node', () => {
    expect(() => assertDockerSourceTargetNode('node-1', 'node-2', 'deployment')).toThrowError(
      expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND' })
    );
  });
});
