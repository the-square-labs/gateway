import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientUuid } from "./client-id";

afterEach(() => vi.unstubAllGlobals());

describe("createClientUuid", () => {
  it("uses randomUUID when the browser provides it", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "native-uuid" });
    expect(createClientUuid()).toBe("native-uuid");
  });

  it("creates a UUID when randomUUID is unavailable in a non-secure context", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(1);
        return bytes;
      },
    });

    expect(createClientUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
