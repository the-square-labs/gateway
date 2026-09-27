import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useCertificatesStore } from "@/stores/certificates";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { renderWithRouter } from "@/test/render";
import { waitForReveal } from "@/test/reveal";
import { Certificates } from "./Certificates";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

describe("Certificates license requirement badge", () => {
  beforeEach(() => {
    useCertificatesStore.setState({ isLoading: false });
    vi.spyOn(useCertificatesStore.getState(), "fetchCertificates").mockResolvedValue();
    vi.spyOn(api, "listCertificateFolders").mockResolvedValue([]);
  });

  it.each([
    ["community", [], true],
    ["business", [], true],
    ["enterprise", [], false],
    ["enterprise", ["internal-pki"], false],
    ["community", ["internal-pki"], false],
  ] as const)("plan=%s, entitlements=%j, shows badge=%s", async (plan, features, visible) => {
    useUIBootstrapStore.setState({
      snapshot: { license: { plan, entitlements: { features } } } as never,
    });

    renderWithRouter(<Certificates />);
    await waitForReveal();

    expect(screen.getByRole("heading", { name: /Certificates/ })).toBeInTheDocument();
    expect(screen.queryByText("Enterprise") !== null).toBe(visible);
  });
});
