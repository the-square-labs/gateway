import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_INGRESS_TARGET,
  ingressTargetValue,
  parseIngressTarget,
} from "@/components/proxy/IngressTargetSelect";
import { IngressGroups } from "@/pages/IngressGroups";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { IngressGroup, IngressGroupMember } from "@/types";
import { groupHealthBadge, memberHealthLabel } from "./ingress-group-format";

function member(overrides: Partial<IngressGroupMember> = {}): IngressGroupMember {
  return {
    nodeId: "node-a",
    priority: 0,
    state: "active",
    drainStartedAt: null,
    lastError: null,
    node: {
      id: "node-a",
      slug: "edge-a",
      hostname: "edge-a",
      displayName: "Edge A",
      status: "online",
      connected: true,
      capable: true,
      addresses: ["192.0.2.10"],
    },
    health: {
      serving: true,
      reason: "",
      configGeneration: 4,
      nginxRunning: true,
      configApplied: true,
      secureLinkSources: 0,
      usableRelayTransports: 0,
      checkedAt: null,
    },
    delivery: { ready: 2, pending: 0, failed: 0 },
    ...overrides,
  };
}

function group(overrides: Partial<IngressGroup> = {}): IngressGroup {
  return {
    id: "group-1",
    name: "Production edge",
    slug: "production-edge",
    description: null,
    folderId: null,
    dnsFailoverMode: "none",
    dnsFailoverNote: "DNS failover: none.",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    members: [
      member(),
      member({
        nodeId: "node-b",
        priority: 1,
        node: { ...member().node!, id: "node-b", slug: "edge-b", displayName: "Edge B" },
      }),
    ],
    routeCount: 2,
    domainCount: 1,
    healthy: true,
    ...overrides,
  };
}

describe("ingress target of a route", () => {
  it("round-trips a node, a group and the automatic choice", () => {
    for (const target of [
      { nodeId: "node-a", ingressGroupId: "", auto: false },
      { nodeId: "", ingressGroupId: "group-1", auto: false },
      { nodeId: "", ingressGroupId: "", auto: true },
    ]) {
      expect(parseIngressTarget(ingressTargetValue(target))).toEqual(target);
    }
    expect(ingressTargetValue({ nodeId: "", ingressGroupId: "", auto: true })).toBe(
      AUTO_INGRESS_TARGET
    );
  });
});

describe("ingress group health", () => {
  it("is healthy, degraded when a member does not serve, and down when no active member serves", () => {
    expect(groupHealthBadge(group()).label).toBe("Healthy");
    const offline = member({ nodeId: "node-b", node: { ...member().node!, connected: false } });
    expect(groupHealthBadge(group({ healthy: false, members: [member(), offline] })).label).toBe(
      "Degraded"
    );
    expect(groupHealthBadge(group({ healthy: false, members: [offline] })).label).toBe("Down");
    expect(memberHealthLabel(offline).label).toBe("Offline");
    expect(
      memberHealthLabel(
        member({ health: { ...member().health!, serving: false, reason: "config not applied" } })
      )
    ).toMatchObject({ label: "Not serving", detail: "config not applied" });
  });
});

describe("Ingress Groups page", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["nodes:details", "nodes:manage"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("lists the groups with their members, usage and health", async () => {
    vi.spyOn(api, "listIngressGroups").mockResolvedValue([group()]);

    render(
      <MemoryRouter>
        <IngressGroups />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("Production edge")).toBeInTheDocument());
    expect(screen.getByText("Edge A")).toBeInTheDocument();
    expect(screen.getByText("Edge B")).toBeInTheDocument();
    expect(screen.getByText("2 routes · 1 domains")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });
});
