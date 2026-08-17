import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LicenseGraceNotice } from "./Dashboard";

describe("LicenseGraceNotice", () => {
  it("shows the grace deadline and license settings action to license managers", () => {
    render(
      <MemoryRouter>
        <LicenseGraceNotice
          graceUntil={new Date(Date.now() + 90 * 60_000).toISOString()}
          canManage
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Gateway license has expired");
    expect(screen.getByRole("alert")).toHaveTextContent("1h 30m remaining");
    expect(screen.getByRole("link", { name: "Update license key" })).toHaveAttribute(
      "href",
      "/settings/general"
    );
  });

  it("shows administrator guidance without an upgrade action to other users", () => {
    render(
      <MemoryRouter>
        <LicenseGraceNotice
          graceUntil={new Date(Date.now() + 60 * 60_000).toISOString()}
          canManage={false}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Contact your administrator before the grace period ends."
    );
    expect(screen.queryByRole("link", { name: "Update license key" })).not.toBeInTheDocument();
  });

  it("renders nothing after the grace deadline", () => {
    const { container } = render(
      <MemoryRouter>
        <LicenseGraceNotice graceUntil={new Date(Date.now() - 60_000).toISOString()} canManage />
      </MemoryRouter>
    );

    expect(container).toBeEmptyDOMElement();
  });
});
