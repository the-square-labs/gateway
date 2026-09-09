import { describe, expect, it } from 'vitest';
import { assertGroupParent } from './group-inheritance.js';

const groups = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'b' },
];
describe('three-level group inheritance', () => {
  it('accepts three edges and rejects a fourth', () => {
    expect(() => assertGroupParent(groups, 'd', 'c')).not.toThrow();
    expect(() => assertGroupParent([...groups, { id: 'd', parentId: 'c' }], 'e', 'd')).toThrow('three levels');
  });
  it('checks descendants when reparenting a subtree', () => {
    const tree = [...groups, { id: 'x', parentId: null }, { id: 'y', parentId: 'x' }];
    expect(() => assertGroupParent(tree, 'x', 'b')).not.toThrow();
    expect(() => assertGroupParent(tree, 'x', 'c')).toThrow('three levels');
  });
  it('rejects missing parents, self-parenting and ancestor cycles', () => {
    expect(() => assertGroupParent(groups, 'x', 'missing')).toThrow('Parent group not found');
    expect(() => assertGroupParent(groups, 'b', 'b')).toThrow('cycle');
    expect(() => assertGroupParent(groups, 'a', 'c')).toThrow('cycle');
  });
});
