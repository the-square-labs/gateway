import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { LicenseFeatureBoundary } from "./LicenseFeatureBoundary";

afterEach(() => {
  cleanup();
  useUIBootstrapStore.setState({ snapshot: null });
});

describe("paid screen loading boundary", () => {
  it.each([
    "community",
    "unavailable",
  ] as const)("does not mount data loaders when the module is %s", (commercialModule) => {
    const fetch = vi.fn();
    function Screen() {
      useEffect(fetch, []);
      return <div>Storage content</div>;
    }
    useUIBootstrapStore.setState({
      snapshot: {
        commercialModule,
        license: {
          plan: "personal",
          entitlementsVersion: 5,
          entitlements: { features: ["storage-connections"] },
        },
      } as never,
    });
    render(
      <LicenseFeatureBoundary feature="storage-connections" capability="Storage connections">
        <Screen />
      </LicenseFeatureBoundary>
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/paid features are not ready/)).toBeInTheDocument();
    act(() =>
      useUIBootstrapStore.setState((state) => ({
        snapshot: { ...state.snapshot!, commercialModule: "ready" },
      }))
    );
    expect(screen.getByText("Storage content")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps retained v4 Personal storage rights without changing the signed feature list", () => {
    const features = ["managed-databases"];
    useUIBootstrapStore.setState({
      snapshot: {
        commercialModule: "ready",
        license: { plan: "personal", entitlementsVersion: 4, entitlements: { features } },
      } as never,
    });
    render(
      <LicenseFeatureBoundary feature="storage-connections" capability="Storage connections">
        <div>Legacy storage</div>
      </LicenseFeatureBoundary>
    );
    expect(screen.getByText("Legacy storage")).toBeInTheDocument();
    expect(features).toEqual(["managed-databases"]);
  });
});
