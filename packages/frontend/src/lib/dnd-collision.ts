import { type CollisionDetection, pointerWithin, rectIntersection } from "@dnd-kit/core";

export const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  // Collapsed folders keep their animated descendants mounted. Their DOM rects
  // still exist outside the clipped body, but they must never receive a drop.
  const visibleArgs = {
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => !container.node.current?.closest('[aria-hidden="true"], [hidden], [inert]')
    ),
  };
  const pointerCollisions = pointerWithin(visibleArgs);
  if (pointerCollisions.length > 0) return pointerCollisions;

  if (args.pointerCoordinates) {
    const ungroupedContainer = visibleArgs.droppableContainers.find((container) => {
      const data = container.data.current;
      return data?.type === "folder" && data.folderId === null;
    });
    const ungroupedRect = ungroupedContainer
      ? args.droppableRects.get(ungroupedContainer.id)
      : undefined;

    if (
      ungroupedContainer &&
      ungroupedRect &&
      args.pointerCoordinates.x >= ungroupedRect.left &&
      args.pointerCoordinates.x <= ungroupedRect.right &&
      args.pointerCoordinates.y >= ungroupedRect.top
    ) {
      return [
        {
          id: ungroupedContainer.id,
          data: { droppableContainer: ungroupedContainer, value: 0 },
        },
      ];
    }
    // Pointer drops are determined by the pointer, not a tall dragged row that
    // happens to overlap another folder while the pointer is outside the list.
    return [];
  }

  return rectIntersection(visibleArgs);
};
