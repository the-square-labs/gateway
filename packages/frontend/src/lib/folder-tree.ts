export interface FolderTreeNodeLike<TNode> {
  id: string;
  children: TNode[];
}

export function collectFolderTreeIds<TNode extends FolderTreeNodeLike<TNode>>(
  nodes: TNode[]
): Set<string> {
  const ids = new Set<string>();

  const visit = (current: TNode[]) => {
    for (const node of current) {
      ids.add(node.id);
      visit(node.children);
    }
  };

  visit(nodes);
  return ids;
}

export function findFolderTreeNode<TNode extends FolderTreeNodeLike<TNode>>(
  nodes: TNode[],
  id: string
): TNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findFolderTreeNode(node.children, id);
    if (found) return found;
  }
  return null;
}
