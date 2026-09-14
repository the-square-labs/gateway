import { describe, expect, it } from 'vitest';
import type { ManagedWorkloadKind, ManagedWorkloadProvider } from './managed-workload-provider.js';

describe('ManagedWorkloadProvider seam', () => {
  it('constrains kind to the two managed workload kinds', () => {
    const kinds: ManagedWorkloadKind[] = ['database', 'storage'];
    expect(kinds).toHaveLength(2);
  });

  it('a minimal provider satisfies the interface shape', () => {
    const p: Pick<ManagedWorkloadProvider, 'kind' | 'resolveImage'> = {
      kind: 'database',
      resolveImage: () => 'image@sha256:deadbeef',
    };
    expect(p.kind).toBe('database');
    expect(p.resolveImage('postgres', '16.14')).toContain('sha256');
  });
});
