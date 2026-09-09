import { describe, expect, it } from 'vitest';
import { assertHostingResourceAction, assertHostingScope } from './hosting-permissions.js';

describe('hosting permission diagnostics', () => {
  it.each([
    [undefined, 'hosting:resources:power'],
    ['vm-1', 'hosting:resources:power:vm-1'],
  ])('reports the evaluated scope for resource %s', (id, requiredScope) => {
    expect(() => assertHostingScope([], 'hosting:resources:power', id)).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: 'HOSTING_ACCESS_DENIED',
        message: `You do not have access to this hosting operation. Required permission: ${requiredScope}`,
        details: { requiredScope },
      })
    );
  });

  it('reports the missing hosted-node permission rather than the already-granted action', () => {
    expect(() =>
      assertHostingResourceAction(['hosting:resources:power:vm-1', 'nodes:details:node-1'], 'vm-1', 'start', ['node-1'])
    ).toThrowError(expect.objectContaining({ details: { requiredScope: 'nodes:config:edit:node-1' } }));
  });

  it.each(['hosting:resources:power', 'hosting:resources:power:vm-1'])('preserves allowed grant %s', (scope) => {
    expect(() => assertHostingScope([scope], 'hosting:resources:power', 'vm-1')).not.toThrow();
  });

  it('still denies an unrelated resource', () => {
    expect(() => assertHostingScope(['hosting:resources:power:vm-2'], 'hosting:resources:power', 'vm-1')).toThrow();
  });
});
