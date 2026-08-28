import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LicensePlanBadge } from "./LicensePlanBadge";

describe("LicensePlanBadge", () => {
  it("explains the required plan on hover", async () => {
    render(<LicensePlanBadge plan="business" label="Business+" />);

    await userEvent.hover(screen.getByText("Business+"));

    expect(
      await screen.findAllByText("This feature requires the Business plan or higher.")
    ).not.toHaveLength(0);
  });
});
