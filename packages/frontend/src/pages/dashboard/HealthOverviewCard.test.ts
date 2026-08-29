import { describe, expect, it } from "vitest";
import type { ProxyHost } from "@/types";
import { sortHealthOverviewHosts } from "./HealthOverviewCard";

describe("sortHealthOverviewHosts", () => {
  it("keeps dashboard proxy hosts in deterministic domain order without mutating the snapshot", () => {
    const hosts = [
      { id: "host-z", domainNames: ["z.example.com"] },
      { id: "host-a", domainNames: ["a.example.com"] },
      { id: "host-b", domainNames: ["a.example.com"] },
    ] as ProxyHost[];

    expect(sortHealthOverviewHosts(hosts).map((host) => host.id)).toEqual([
      "host-a",
      "host-b",
      "host-z",
    ]);
    expect(hosts.map((host) => host.id)).toEqual(["host-z", "host-a", "host-b"]);
  });

  it("puts unhealthy proxy hosts before healthy and disabled hosts", () => {
    const hosts = [
      { id: "healthy-a", domainNames: ["a.example.com"], healthStatus: "online" },
      { id: "disabled-b", domainNames: ["b.example.com"], healthStatus: "disabled" },
      { id: "recovering-c", domainNames: ["c.example.com"], healthStatus: "recovering" },
      { id: "degraded-d", domainNames: ["d.example.com"], healthStatus: "degraded" },
      { id: "offline-z", domainNames: ["z.example.com"], healthStatus: "offline" },
    ] as ProxyHost[];

    expect(sortHealthOverviewHosts(hosts).map((host) => host.id)).toEqual([
      "offline-z",
      "recovering-c",
      "degraded-d",
      "healthy-a",
      "disabled-b",
    ]);
  });
});
