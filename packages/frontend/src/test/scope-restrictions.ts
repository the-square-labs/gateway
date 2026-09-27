import { act, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

const CLOSED = /^(Restrict |Show |Expand )/;

function closedRestrictionButtons() {
  return screen
    .queryAllByRole("button")
    .filter((button) => CLOSED.test(button.getAttribute("aria-label") ?? ""));
}

/**
 * Opens every restriction summary ("Restrict…", read-only "Show") and folds out every node and
 * folder group, as a user does before picking resources. Groups that appear once more resources
 * load are opened too.
 */
export async function expandScopeRestrictions() {
  await waitFor(() => expect(closedRestrictionButtons().length).toBeGreaterThan(0));
  let quietRounds = 0;
  while (quietRounds < 2) {
    const closed = closedRestrictionButtons();
    await act(async () => {
      for (const button of closed) button.click();
      await Promise.resolve();
    });
    quietRounds = closed.length === 0 ? quietRounds + 1 : 0;
  }
}
