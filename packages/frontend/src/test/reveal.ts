import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Waits until every page, tab panel and dialog gate has revealed its content.
 * Role queries skip hidden content, so query after this once data has loaded.
 */
export async function waitForReveal() {
  await waitFor(() =>
    expect(
      document.querySelector('[data-reveal-phase]:not([data-reveal-phase="revealed"])')
    ).toBeNull()
  );
}
