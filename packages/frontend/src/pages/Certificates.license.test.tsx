import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCertificatesStore } from "@/stores/certificates";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { renderWithRouter } from "@/test/render";
import { Certificates } from "./Certificates";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

describe("Certificates license requirement badge", () => {
  beforeEach(() => {
    useCertificatesStore.setState({ isLoading: false });
    vi.spyOn(useCertificatesStore.getState(), "fetchCertificates").mockResolvedValue();
  });

  it.each([
    ["community", [], true],
    ["business", [], true],
    ["enterprise", [], false],
    ["enterprise", ["internal-pki"], false],
    ["community", ["internal-pki"], false],
  ] as const)("plan=%s, entitlements=%j, shows badge=%s", (plan, features, visible) => {
    useUIBootstrapStore.setState({
      snapshot: { license: { plan, entitlements: { features } } } as never,
    });

    renderWithRouter(<Certificates />);

    expect(screen.getByRole("heading", { name: /Certificates/ })).toBeInTheDocument();
    expect(screen.queryByText("Enterprise") !== null).toBe(visible);
  });
});
