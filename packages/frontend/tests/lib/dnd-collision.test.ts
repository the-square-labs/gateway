import { pointerWithin, rectIntersection } from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pointerFirstCollisionDetection } from "../../src/lib/dnd-collision";

vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  pointerWithin: vi.fn(),
  rectIntersection: vi.fn(),
}));

const args = { droppableContainers: [] } as unknown as Parameters<
  typeof pointerFirstCollisionDetection
>[0];

describe("pointerFirstCollisionDetection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the droppable under the pointer over the dragged row intersection", () => {
    const pointerCollision = [{ id: "ungrouped", data: {} }];
    vi.mocked(pointerWithin).mockReturnValue(pointerCollision);
    vi.mocked(rectIntersection).mockReturnValue([{ id: "last-folder", data: {} }]);

    expect(pointerFirstCollisionDetection(args)).toBe(pointerCollision);
    expect(rectIntersection).not.toHaveBeenCalled();
  });

  it("falls back to rectangle intersections for keyboard dragging", () => {
    const rectangleCollision = [{ id: "target", data: {} }];
    vi.mocked(pointerWithin).mockReturnValue([]);
    vi.mocked(rectIntersection).mockReturnValue(rectangleCollision);

    expect(pointerFirstCollisionDetection(args)).toBe(rectangleCollision);
    expect(rectIntersection).toHaveBeenCalledWith(args);
  });

  it("treats the area below the final ungrouped section as ungrouped", () => {
    const ungroupedContainer = {
      id: "ungrouped",
      node: { current: document.createElement("div") },
      data: { current: { type: "folder", folderId: null } },
    };
    const bottomDropArgs = {
      pointerCoordinates: { x: 300, y: 900 },
      droppableContainers: [ungroupedContainer],
      droppableRects: new Map([
        ["ungrouped", { left: 100, right: 700, top: 500, bottom: 600, width: 600, height: 100 }],
      ]),
    } as unknown as Parameters<typeof pointerFirstCollisionDetection>[0];
    vi.mocked(pointerWithin).mockReturnValue([]);

    expect(pointerFirstCollisionDetection(bottomDropArgs)).toEqual([
      {
        id: "ungrouped",
        data: { droppableContainer: ungroupedContainer, value: 0 },
      },
    ]);
    expect(rectIntersection).not.toHaveBeenCalled();
  });
  it("excludes rows and nested folders clipped inside a collapsed folder", () => {
    const collapsedBody = document.createElement("div");
    collapsedBody.setAttribute("aria-hidden", "true");
    const hiddenRow = document.createElement("div");
    const hiddenFolder = document.createElement("div");
    collapsedBody.append(hiddenRow, hiddenFolder);
    const containers = [hiddenRow, hiddenFolder, document.createElement("div")].map((node, id) => ({
      id,
      node: { current: node },
    }));
    vi.mocked(pointerWithin).mockReturnValue([]);
    vi.mocked(rectIntersection).mockReturnValue([]);
    pointerFirstCollisionDetection({ ...args, droppableContainers: containers } as never);
    expect(vi.mocked(pointerWithin).mock.calls[0][0].droppableContainers).toEqual([containers[2]]);
    expect(vi.mocked(rectIntersection).mock.calls[0][0].droppableContainers).toEqual([
      containers[2],
    ]);
  });
  it("does not drop onto a folder just because the dragged row overlaps it", () => {
    vi.mocked(pointerWithin).mockReturnValue([]);
    vi.mocked(rectIntersection).mockReturnValue([{ id: "wrong-folder" }]);
    expect(pointerFirstCollisionDetection({ ...args, pointerCoordinates: { x: 1, y: 1 } })).toEqual(
      []
    );
    expect(rectIntersection).not.toHaveBeenCalled();
  });
});
