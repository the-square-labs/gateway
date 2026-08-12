import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  routeScrollRestorationTestApi,
  useRouteScrollRestoration,
} from "./use-route-scroll-restoration";

function ListPage() {
  const navigate = useNavigate();
  return (
    <div data-page-transition="">
      <div className="overflow-y-auto">
        <button type="button" onClick={() => navigate("/resources/item-1")}>
          Open resource
        </button>
        <div data-route-scroll-container="" className="overflow-auto">
          Nested virtualized table
        </div>
      </div>
    </div>
  );
}

function DetailPage() {
  const navigate = useNavigate();
  return (
    <div data-page-transition="">
      <button type="button" onClick={() => navigate("/resources")}>
        Back to resources
      </button>
    </div>
  );
}

function Harness() {
  useRouteScrollRestoration("user-1");
  return (
    <Routes>
      <Route path="/resources" element={<ListPage />} />
      <Route path="/resources/:id" element={<DetailPage />} />
    </Routes>
  );
}

afterEach(() => routeScrollRestorationTestApi.clear());

describe("useRouteScrollRestoration", () => {
  it("restores a list scroller after a different detail component unmounts it", async () => {
    render(
      <MemoryRouter initialEntries={["/resources"]}>
        <Harness />
      </MemoryRouter>
    );

    const firstScroller = document.querySelector<HTMLElement>(".overflow-y-auto");
    expect(firstScroller).not.toBeNull();
    firstScroller!.scrollTop = 420;
    fireEvent.scroll(firstScroller!);

    fireEvent.click(screen.getByRole("button", { name: "Open resource" }));
    expect(await screen.findByRole("button", { name: "Back to resources" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to resources" }));

    await waitFor(() => {
      const restoredScroller = document.querySelector<HTMLElement>(".overflow-y-auto");
      const nestedTableScroller = document.querySelector<HTMLElement>(
        "[data-route-scroll-container]"
      );
      expect(restoredScroller).not.toBe(firstScroller);
      expect(restoredScroller?.scrollTop).toBe(420);
      expect(nestedTableScroller?.scrollTop).toBe(0);
    });
  });
});
