import { describe, expect, it } from "vitest";
import { resolveDeploymentImageReference } from "./docker-image-ref";

describe("deployment slot image references", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  it("maps the configured digest to its canonical reference", () => {
    expect(resolveDeploymentImageReference(digest, digest, "nginx:alpine")).toBe("nginx:alpine");
  });
  it("does not relabel an older standby image as the desired version", () => {
    expect(resolveDeploymentImageReference("nginx:1.28", digest, "nginx:alpine")).toBe(
      "nginx:1.28"
    );
    const oldDigest = `sha256:${"b".repeat(64)}`;
    expect(resolveDeploymentImageReference(oldDigest, digest, "nginx:alpine")).toBe(oldDigest);
  });
  it("uses the selected slot's own archive reference", () => {
    expect(
      resolveDeploymentImageReference(digest, digest, "nginx:new", {
        Config: {
          Image: digest,
          Labels: { "wiolett.gateway.archive.image.reference": "nginx:old" },
        },
      })
    ).toBe("nginx:old");
  });
  it("preserves digest-only resources and does not invent missing slot images", () => {
    expect(resolveDeploymentImageReference(digest, digest)).toBe(digest);
    expect(resolveDeploymentImageReference(null, digest, "nginx:alpine")).toBe("—");
  });
});
