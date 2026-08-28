import { calculateAvatarCropRect, clampAvatarOffset } from "./AvatarCropDialog";

describe("AvatarCropDialog geometry", () => {
  it("keeps a landscape image covering the square crop area", () => {
    expect(
      clampAvatarOffset({
        offset: { x: 100, y: -50 },
        image: { width: 800, height: 600 },
        previewSize: 320,
        zoom: 1,
      })
    ).toEqual({ x: expect.closeTo(53.333, 2), y: 0 });
  });

  it("maps the centered viewport to a square source crop", () => {
    const crop = calculateAvatarCropRect({
      image: { width: 800, height: 600 },
      previewSize: 320,
      zoom: 1,
      offset: { x: 0, y: 0 },
    });

    expect(crop.sourceX).toBeCloseTo(100);
    expect(crop.sourceY).toBeCloseTo(0);
    expect(crop.sourceSize).toBeCloseTo(600);
  });

  it("translates preview movement into the corresponding source crop", () => {
    const crop = calculateAvatarCropRect({
      image: { width: 800, height: 600 },
      previewSize: 320,
      zoom: 1,
      offset: { x: 40, y: 0 },
    });

    expect(crop.sourceX).toBeCloseTo(25);
    expect(crop.sourceY).toBeCloseTo(0);
  });
});
