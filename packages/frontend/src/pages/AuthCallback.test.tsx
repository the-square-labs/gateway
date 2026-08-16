import { screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, vi } from "vitest";
import { AuthCallback } from "@/pages/AuthCallback";
import { renderWithRouter } from "@/test/render";

afterEach(() => vi.restoreAllMocks());

describe("AuthCallback", () => {
  it("loads the current user and redirects after a successful callback", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "user-1" }));
    const onAuthenticated = vi.fn();

    renderWithRouter(
      <StrictMode>
        <AuthCallback onAuthenticated={onAuthenticated} />
      </StrictMode>,
      {
        path: "/callback",
        route:
          "/callback?return_to=http%3A%2F%2Flocalhost%3A3000%2Fproxy-hosts%2Froute-1%3Ftab%3Dssl",
      }
    );

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith("/proxy-hosts/route-1?tab=ssl");
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith("/auth/me", { credentials: "include" });
  });

  it("shows an error when the current user request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "Invalid or expired session" }, { status: 401 })
    );

    renderWithRouter(<AuthCallback />, {
      path: "/callback",
      route: "/callback",
    });

    expect(await screen.findByText("Authentication Failed")).toBeInTheDocument();
    expect(screen.getByText("Invalid or expired session")).toBeInTheDocument();
  });
});
