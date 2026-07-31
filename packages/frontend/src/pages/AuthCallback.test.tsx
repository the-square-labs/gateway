import { screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { Route } from "react-router-dom";
import { vi } from "vitest";
import { AuthCallback } from "@/pages/AuthCallback";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";

describe("AuthCallback", () => {
  it("loads the current user and redirects after a successful callback", async () => {
    vi.spyOn(api, "getCurrentUser").mockResolvedValue(makeUser({ scopes: ["nodes:details"] }));

    renderWithRouter(
      <StrictMode>
        <AuthCallback />
      </StrictMode>,
      {
        path: "/callback",
        route: "/callback",
        extraRoutes: <Route path="/" element={<div>Dashboard Home</div>} />,
      }
    );

    expect(await screen.findByText("Dashboard Home")).toBeInTheDocument();

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });
    expect(api.getCurrentUser).toHaveBeenCalledOnce();
  });

  it("shows an error when the current user request fails", async () => {
    vi.spyOn(api, "getCurrentUser").mockRejectedValue(new Error("Invalid or expired session"));

    renderWithRouter(<AuthCallback />, {
      path: "/callback",
      route: "/callback",
    });

    expect(await screen.findByText("Authentication Failed")).toBeInTheDocument();
    expect(screen.getByText("Invalid or expired session")).toBeInTheDocument();
  });
});
