import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LICENSE_FEATURE_PLANS,
  type LicenseFeature,
  requireMinimumLicensePlan,
  useLicensePaywallStore,
} from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { LicensePlan } from "@/types";
import { LicensePlanBadge } from "./LicensePlanBadge";

function setLicense(plan: LicensePlan, features: string[] = []) {
  useUIBootstrapStore.setState({
    snapshot: { license: { plan, entitlements: { features } } } as never,
  });
}

beforeEach(() => {
  useUIBootstrapStore.setState({ snapshot: null });
  useLicensePaywallStore.setState({ request: null });
});

afterEach(() => {
  useUIBootstrapStore.setState({ snapshot: null });
  useLicensePaywallStore.setState({ request: null });
});

describe("LicensePlanBadge", () => {
  const plans: LicensePlan[] = ["community", "personal", "business", "enterprise"];
  const features = Object.keys(LICENSE_FEATURE_PLANS) as LicenseFeature[];

  it.each(features)("only shows an unavailable %s below its required plan", (feature) => {
    for (const plan of plans) {
      setLicense(plan);
      // The badge and the shared paywall must agree on the plan hierarchy.
      const requiresUpgrade = !requireMinimumLicensePlan(LICENSE_FEATURE_PLANS[feature], feature);
      useLicensePaywallStore.setState({ request: null });
      const { container, unmount } = render(<LicensePlanBadge feature={feature} />);

      expect(container.textContent !== "").toBe(requiresUpgrade);
      expect(useLicensePaywallStore.getState().request).toBeNull();
      unmount();
    }
  });

  it.each(features)("hides an entitled %s even on a lower plan", (feature) => {
    setLicense("community", [feature]);
    const { container } = render(<LicensePlanBadge feature={feature} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not advertise an upgrade before license data is known", () => {
    const { container } = render(<LicensePlanBadge feature="internal-pki" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reacts to bootstrap, upgrades, downgrades and entitlement changes", () => {
    const { container } = render(<LicensePlanBadge feature="internal-pki" />);
    expect(container).toBeEmptyDOMElement();

    act(() => setLicense("business"));
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    act(() => setLicense("enterprise"));
    expect(container).toBeEmptyDOMElement();
    act(() => setLicense("business"));
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    act(() => setLicense("business", ["internal-pki"]));
    expect(container).toBeEmptyDOMElement();
    act(() => setLicense("business", ["siem-export"]));
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
  });

  it("explains the required plan on hover", async () => {
    setLicense("personal");
    render(<LicensePlanBadge feature="git-push-to-deploy" label="Business+" />);

    await userEvent.hover(screen.getByText("Business+"));

    expect(
      await screen.findAllByText("This feature requires the Business plan or higher.")
    ).not.toHaveLength(0);
  });
});
