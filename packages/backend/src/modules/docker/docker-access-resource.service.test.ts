import { describe, expect, it } from 'vitest';
import {
  dockerScopedNodeIds,
  parseDockerChildScopeResourceId,
  rewriteDockerResourceScopes,
} from './docker-access-resource.service.js';

describe('Docker access resource scopes', () => {
  it('parses child resource ids and derives their owning nodes', () => {
    expect(parseDockerChildScopeResourceId('node-1/resource-1')).toEqual({
      nodeId: 'node-1',
      resourceId: 'resource-1',
    });
    expect(parseDockerChildScopeResourceId('node-1')).toBeNull();
    expect(
      dockerScopedNodeIds(
        [
          'docker:containers:view:node-1/resource-1',
          'docker:containers:view:node-2',
          'docker:containers:edit:node-3/resource-3',
        ],
        ['docker:containers:view']
      )
    ).toEqual(['node-1', 'node-2', 'node-3']);
  });

  it('moves every matching Docker container permission while preserving unrelated scopes', () => {
    expect(
      rewriteDockerResourceScopes(
        [
          'docker:containers:view:node-1/resource-1',
          'docker:containers:edit:node-1/resource-1',
          'docker:containers:view:node-1/resource-2',
          'docker:images:view:node-1/resource-1',
          'proxy:view:host-1',
        ],
        'node-1/resource-1',
        'node-2/resource-1'
      )
    ).toEqual([
      'docker:containers:edit:node-2/resource-1',
      'docker:containers:view:node-1/resource-2',
      'docker:containers:view:node-2/resource-1',
      'docker:images:view:node-1/resource-1',
      'proxy:view:host-1',
    ]);
  });

  it('removes grants when the underlying resource is deleted', () => {
    expect(
      rewriteDockerResourceScopes(
        ['docker:containers:view:node-1/resource-1', 'docker:containers:view:node-1/resource-2'],
        'node-1/resource-1',
        null
      )
    ).toEqual(['docker:containers:view:node-1/resource-2']);
  });
});
