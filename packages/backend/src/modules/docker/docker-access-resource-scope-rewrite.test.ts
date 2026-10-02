import { describe, expect, it } from 'vitest';
import { copyDockerVolumeScopes, dropDockerVolumeScopes } from './docker-access-resource-scope-rewrite.js';

describe('grants on a migrated volume', () => {
  const granted = ['docker:volumes:view:source/data', 'docker:volumes:files:read:source/data', 'proxy:view'];

  it('apply to its copy on the target node as well', () => {
    expect(copyDockerVolumeScopes(granted, 'source', 'target', 'data')).toEqual([
      'docker:volumes:files:read:source/data',
      'docker:volumes:files:read:target/data',
      'docker:volumes:view:source/data',
      'docker:volumes:view:target/data',
      'proxy:view',
    ]);
    // Another volume, or the same name on another node, is not touched.
    const unrelated = ['docker:volumes:view:source/other', 'docker:volumes:view:third/data'];
    expect(copyDockerVolumeScopes(unrelated, 'source', 'target', 'data')).toEqual(unrelated);
  });

  it('leave with the source volume once the migration removed it', () => {
    expect(dropDockerVolumeScopes([...granted, 'docker:volumes:view:target/data'], 'source', 'data')).toEqual([
      'proxy:view',
      'docker:volumes:view:target/data',
    ]);
  });
});
