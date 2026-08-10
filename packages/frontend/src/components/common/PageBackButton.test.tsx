import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PageBackButton } from "./PageBackButton";

describe("PageBackButton", () => {
  it("returns to the originating chat when a resource link supplied return state", () => {
    const fallback = vi.fn();
    render(
      <MemoryRouter
        initialEntries={[
          "/chat",
          {
            pathname: "/docker/containers/docker-src/ai-e2e-restart",
            state: { returnTo: "/chat" },
          },
        ]}
        initialIndex={1}
      >
        <Routes>
          <Route path="/chat" element={<div>Assistant chat</div>} />
          <Route
            path="/docker/containers/:node/:container"
            element={<PageBackButton onClick={fallback} />}
          />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByText("Assistant chat")).toBeInTheDocument();
    expect(fallback).not.toHaveBeenCalled();
  });
});
