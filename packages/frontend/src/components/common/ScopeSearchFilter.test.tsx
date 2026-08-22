import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScopeSearchFilter } from "./ScopeSearchFilter";

describe("ScopeSearchFilter", () => {
  it("combines search with all, selected, and unselected display modes", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(
      <ScopeSearchFilter
        search=""
        onSearchChange={vi.fn()}
        filter="all"
        onFilterChange={onFilterChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Filter scopes: All items" }));
    expect(screen.getByRole("menuitemradio", { name: "Unselected only" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: "Selected only" }));
    expect(onFilterChange).toHaveBeenCalledWith("selected");
  });
});
