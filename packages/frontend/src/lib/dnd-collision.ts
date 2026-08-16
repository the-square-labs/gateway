import { type CollisionDetection, pointerWithin, rectIntersection } from "@dnd-kit/core";

export const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;

  if (args.pointerCoordinates) {
    const ungroupedContainer = args.droppableContainers.find((container) => {
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
  }

  return rectIntersection(args);
};
