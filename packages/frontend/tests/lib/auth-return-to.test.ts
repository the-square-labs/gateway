import { describe, expect, it } from "vitest";
import { getLoginRedirectUrl, resolveAuthReturnTo } from "../../src/lib/auth-return-to";

describe("auth return path", () => {
  it("keeps the complete same-origin deep link in the login URL", () => {
    expect(getLoginRedirectUrl("http://localhost:3000/proxy-hosts/route-1?tab=ssl#details")).toBe(
      "/login?return_to=http%3A%2F%2Flocalhost%3A3000%2Fproxy-hosts%2Froute-1%3Ftab%3Dssl%23details"
    );
  });

  it("resolves a same-origin target after authentication", () => {
    expect(
      resolveAuthReturnTo(
        "?return_to=http%3A%2F%2Flocalhost%3A3000%2Fproxy-hosts%2Froute-1%3Ftab%3Dssl%23details",
        "http://localhost:3000"
      )
    ).toBe("/proxy-hosts/route-1?tab=ssl#details");
  });

  it.each([
    "https://attacker.example/steal",
    "http://localhost:3000/login",
    "http://localhost:3000/callback",
    "http://[::1",
  ])("falls back to the dashboard for unsafe target %s", (target) => {
    expect(
      resolveAuthReturnTo(`?return_to=${encodeURIComponent(target)}`, "http://localhost:3000")
    ).toBe("/");
  });
});
