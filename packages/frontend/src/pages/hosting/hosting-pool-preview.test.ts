import { describe, expect, it } from "vitest";
import { previewHostingPool } from "./hosting-pool-preview";

describe("hosting pool form feedback", () => {
  it("counts mixed inclusive VMID ranges and deduplicates overlaps", () => {
    const ids = previewHostingPool("250-260,271,273-280,250", "vmid");
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe(250);
    expect(ids.at(-1)).toBe(280);
  });
  it("counts IPv4 ranges including octet transitions", () => {
    expect(previewHostingPool("192.0.2.254-192.0.3.1,192.0.2.255", "ipv4")).toHaveLength(4);
  });
  it.each([
    "260-250",
    "99",
    "1000000000",
    "250,",
    "1e3",
    "100-999999999",
  ])("rejects invalid or unbounded VMID pool %s", (text) =>
    expect(() => previewHostingPool(text, "vmid")).toThrow());
  it.each([
    "192.0.2.256",
    "192.0.2.5-192.0.2.1",
    "192.0.2.01",
    "0.0.0.0-255.255.255.255",
  ])("rejects invalid or unbounded IP syntax %s", (text) =>
    expect(() => previewHostingPool(text, "ipv4")).toThrow());
});
