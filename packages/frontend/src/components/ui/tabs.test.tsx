import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { Tabs, TabsContent } from "./tabs";

vi.mock("@/components/common/PageTransition", () => ({
  PageTransition: ({ children, offsetY }: { children: ReactNode; offsetY?: number }) => (
    <div data-testid="tab-transition" data-offset-y={String(offsetY)}>
      {children}
    </div>
  ),
}));

it("uses a fade-only transition for tab content", () => {
  render(
    <Tabs defaultValue="monitoring">
      <TabsContent value="monitoring">Monitoring content</TabsContent>
    </Tabs>
  );

  expect(screen.getByTestId("tab-transition")).toHaveAttribute("data-offset-y", "0");
  expect(screen.getByText("Monitoring content")).toBeVisible();
});
