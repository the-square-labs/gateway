import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useContext } from "react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "@/components/ui/skeleton";
import { InitialPageReadyContext, PageTransition } from "./PageTransition";

function ReadyProbe() {
  const ready = useContext(InitialPageReadyContext);
  return <span>{ready ? "Page ready" : "Page waiting"}</span>;
}

describe("PageTransition", () => {
  it("reveals navigated page content only after its initial data is ready", async () => {
    const { rerender } = render(
      <PageTransition>
        <Skeleton />
        <ReadyProbe />
      </PageTransition>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(transition).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Page waiting")).toBeInTheDocument();

    rerender(
      <PageTransition>
        <div>Ready content</div>
        <ReadyProbe />
      </PageTransition>
    );

    await waitFor(() => {
      expect(screen.getByText("Ready content")).toBeVisible();
      expect(screen.getByText("Page ready")).toBeVisible();
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

  it("keeps initial content hidden while StrictMode replays layout effects", async () => {
    const { rerender } = render(
      <StrictMode>
        <PageTransition>
          <Skeleton />
        </PageTransition>
      </StrictMode>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(transition).toHaveAttribute("aria-busy", "true");

    rerender(
      <StrictMode>
        <PageTransition>
          <div>StrictMode content ready</div>
        </PageTransition>
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText("StrictMode content ready")).toBeVisible();
      expect(transition).toHaveStyle({ visibility: "visible" });
    });
  });

  it("waits for initial data again when keyed tab content changes", async () => {
    const { rerender } = render(
      <PageTransition key="general">
        <div>General settings</div>
      </PageTransition>
    );

    const generalTransition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(generalTransition).toHaveStyle({ visibility: "visible" });

    rerender(
      <PageTransition key="features">
        <Skeleton />
      </PageTransition>
    );

    const featuresTransition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(featuresTransition).not.toBe(generalTransition);
    expect(featuresTransition).toHaveStyle({ visibility: "hidden" });
    expect(featuresTransition).toHaveAttribute("aria-busy", "true");

    rerender(
      <PageTransition key="features">
        <div>Features settings</div>
      </PageTransition>
    );

    await waitFor(() => {
      expect(screen.getByText("Features settings")).toBeVisible();
      expect(featuresTransition).toHaveStyle({ visibility: "visible" });
    });
  });
});
