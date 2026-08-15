import { describe, expect, it } from "vitest";
import { getDomainCreationBlocker } from "./Domains";

describe("domain creation availability", () => {
  it("blocks creation before the form opens when there are no Nginx nodes", () => {
    expect(
      getDomainCreationBlocker(
        {
          eligibleNodes: [],
          unconfiguredNodes: [],
          totalNginxNodes: 0,
          unconfiguredNginxNodes: 0,
        },
        false
      )
    ).toBe("no_nodes");
  });

  it("blocks creation when every Nginx node lacks a public address", () => {
    expect(
      getDomainCreationBlocker(
        {
          eligibleNodes: [],
          unconfiguredNodes: [
            {
              id: "node-1",
              slug: "private-edge",
              hostname: "private-edge",
              displayName: null,
              appearanceColor: null,
            },
          ],
          totalNginxNodes: 1,
          unconfiguredNginxNodes: 1,
        },
        false
      )
    ).toBe("no_public_address");
  });

  it("requires Cloudflare after the Nginx node is ready", () => {
    expect(
      getDomainCreationBlocker(
        {
          eligibleNodes: [
            {
              id: "node-1",
              slug: "public-edge",
              hostname: "public-edge",
              displayName: "Public edge",
              appearanceColor: null,
              effectiveAddress: "1.1.1.1",
            },
          ],
          unconfiguredNodes: [],
          totalNginxNodes: 1,
          unconfiguredNginxNodes: 0,
        },
        false
      )
    ).toBe("cloudflare");
  });

  it("opens the form after both prerequisites are ready", () => {
    expect(
      getDomainCreationBlocker(
        {
          eligibleNodes: [
            {
              id: "node-1",
              slug: "public-edge",
              hostname: "public-edge",
              displayName: "Public edge",
              appearanceColor: null,
              effectiveAddress: "1.1.1.1",
            },
          ],
          unconfiguredNodes: [],
          totalNginxNodes: 1,
          unconfiguredNginxNodes: 0,
        },
        true
      )
    ).toBeNull();
  });
});
