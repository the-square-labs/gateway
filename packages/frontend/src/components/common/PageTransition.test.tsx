import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTransition } from "./PageTransition";

describe("PageTransition", () => {
  it("reveals navigated page content only after its initial data is ready", async () => {
    const { rerender } = render(
      <PageTransition>
        <Skeleton />
      </PageTransition>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(transition).toHaveAttribute("aria-busy", "true");

    rerender(
      <PageTransition>
        <div>Ready content</div>
      </PageTransition>
    );

    await waitFor(() => {
      expect(screen.getByText("Ready content")).toBeVisible();
      expect(transition).toHaveStyle({ visibility: "visible" });
      expect(transition).not.toHaveAttribute("aria-busy");
    });
  });

  it("does not hide a page for later local loading states", () => {
    const { rerender } = render(
      <PageTransition>
        <div>Ready content</div>
      </PageTransition>
    );

    rerender(
      <PageTransition>
        <Skeleton />
      </PageTransition>
    );

    expect(document.querySelector("[data-page-transition]")).toHaveStyle({ visibility: "visible" });
  });
});
