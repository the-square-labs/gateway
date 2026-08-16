import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { PageTransition } from "@/components/common/PageTransition";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { NodeDetail, ProxyHost } from "@/types";
import { DetailsTab } from "./DetailsTab";

const HOST = {
  id: "proxy-1",
  nodeId: "node-1",
  type: "proxy",
  domainNames: ["example.test"],
  forwardHost: "app",
  forwardPort: 80,
  forwardScheme: "http",
  healthCheckEnabled: false,
  sslEnabled: false,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
} as ProxyHost;

describe("proxy host details tab", () => {
  it("reveals the first frame only after its node card is ready", async () => {
    useUIBootstrapStore.getState().clear();
    api.invalidateCache("req:/api/nodes/node-1");
    let resolveNode!: (node: NodeDetail) => void;
    vi.spyOn(api, "getNode").mockReturnValueOnce(
      new Promise<NodeDetail>((resolve) => {
        resolveNode = resolve;
      })
    );

    render(
      <MemoryRouter>
        <PageTransition>
          <DetailsTab host={HOST} />
        </PageTransition>
      </MemoryRouter>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(screen.queryByText("http-gateway")).not.toBeInTheDocument();

    await act(async () =>
      resolveNode({
        id: "node-1",
        slug: "http-gateway",
        hostname: "http-gateway",
        displayName: null,
        type: "nginx",
        status: "online",
      } as NodeDetail)
    );

    await waitFor(() => {
      expect(transition).toHaveStyle({ visibility: "visible" });
      expect(screen.getByText("http-gateway")).toBeVisible();
    });
  });

  it("links route domains and certificates to their existing resource screens", () => {
    useUIBootstrapStore.getState().clear();
    api.setCache("req:/api/nodes/node-1", {
      data: {
        id: "node-1",
        slug: "edge-one",
        hostname: "edge-one",
        displayName: "Edge One",
        type: "nginx",
        status: "online",
      },
    });

    render(
      <MemoryRouter>
        <DetailsTab
          host={
            {
              ...HOST,
              sslEnabled: true,
              sslCertificate: {
                id: "cert-1",
                name: "example.test",
                type: "acme",
                status: "active",
              },
            } as ProxyHost
          }
        />
      </MemoryRouter>
    );

    const resourceLinks = screen.getAllByRole("link", { name: "example.test" });
    expect(resourceLinks[0]).toHaveAttribute("href", "/domains?domain=example.test");
    expect(resourceLinks[0]?.firstElementChild).toHaveClass("bg-blue-500/15");
    expect(resourceLinks[1]).toHaveAttribute("href", "/ssl-certificates?certificate=cert-1");
  });
});
