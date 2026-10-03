import { describe, expect, it } from 'vitest';
import { orderBuildersLikeNodeList } from './docker-build-policy.js';

const node = (id: string, folderId: string | null, sortOrder: number) => ({
  id,
  folderId,
  sortOrder,
  createdAt: '2026-01-01T00:00:00Z',
});

describe('orderBuildersLikeNodeList', () => {
  it('orders like the Nodes list: folders by position, subfolders before a folder’s nodes, root nodes last', () => {
    const folders = [
      { id: 'b', parentId: null, sortOrder: 1 },
      { id: 'a', parentId: null, sortOrder: 0 },
      { id: 'a1', parentId: 'a', sortOrder: 0 },
    ];
    const ordered = orderBuildersLikeNodeList(
      [
        node('root-2', null, 2),
        node('in-b', 'b', 0),
        node('in-a-2', 'a', 1),
        node('root-1', null, 1),
        node('in-a1', 'a1', 0),
        node('in-a-1', 'a', 0),
      ],
      folders
    );
    expect(ordered.map((n) => n.id)).toEqual(['in-a1', 'in-a-1', 'in-a-2', 'in-b', 'root-1', 'root-2']);
  });

  it('treats a node in a deleted folder as a root node', () => {
    const ordered = orderBuildersLikeNodeList(
      [node('gone', 'missing', 0), node('kept', 'f', 5)],
      [{ id: 'f', parentId: null, sortOrder: 0 }]
    );
    expect(ordered.map((n) => n.id)).toEqual(['kept', 'gone']);
  });
});
