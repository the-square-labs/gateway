import { describe, expect, it } from "vitest";
import { resolveLicensePlan } from "./license-plan";

describe("resolveLicensePlan", () => {
  it("uses the current plan contract", () => {
    expect(resolveLicensePlan({ plan: "business", status: "valid", hasKey: true })).toBe(
      "business"
    );
  });

  it("keeps legacy Community responses in Community", () => {
    expect(resolveLicensePlan({ status: "community", hasKey: false })).toBe("community");
  });

  it("maps legacy paid tiers without inventing Enterprise", () => {
    expect(resolveLicensePlan({ status: "valid", hasKey: true, tier: "homelab" })).toBe("personal");
    expect(resolveLicensePlan({ status: "valid", hasKey: true, tier: "enterprise" })).toBe(
      "enterprise"
    );
    expect(resolveLicensePlan({ status: "valid", hasKey: true })).toBe("community");
  });
});
