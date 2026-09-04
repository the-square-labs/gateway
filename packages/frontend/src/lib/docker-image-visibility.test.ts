import { describe, expect, it } from "vitest";
import { isInternalAvailabilityImage, isUserDockerRegistry } from "./docker-image-visibility";

describe("Docker user-facing image choices", () => {
  it("hides internal HA references without hiding normal application images", () => {
    for (const reference of [
      "127.0.0.1:5443/gateway/availability/p/1/9:image",
      "gateway/availability/p:hash",
      "registry.local/gateway/availability/p@sha256:abc",
    ]) {
      expect(isInternalAvailabilityImage(reference)).toBe(true);
    }
    for (const reference of [
      "nginx:alpine",
      "gateway-av-e2e-harness:v1",
      "registry.local/team/app:v1",
    ]) {
      expect(isInternalAvailabilityImage(reference)).toBe(false);
    }
  });
  it("excludes system registries, including responses without source metadata", () => {
    expect(isUserDockerRegistry({ id: "gateway-internal-registry" })).toBe(false);
    expect(isUserDockerRegistry({ id: "system", source: "system" })).toBe(false);
    expect(isUserDockerRegistry({ id: "user", source: "manual" })).toBe(true);
  });
});
