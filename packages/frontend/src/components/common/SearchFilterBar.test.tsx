import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchFilterBar } from "./SearchFilterBar";

it("opens requested filters and still lets the user collapse them", async () => {
  render(
    <SearchFilterBar
      search=""
      onSearchChange={vi.fn()}
      hasActiveFilters
      onReset={vi.fn()}
      initialFiltersOpen
      filters={<span>Node filter</span>}
    />
  );
  const toggle = screen.getByRole("button", { name: "Filters" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(screen.getByText("Node filter")).toBeVisible());
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it("keeps filters collapsed by default on existing consumers", () => {
  render(
    <SearchFilterBar
      search=""
      onSearchChange={vi.fn()}
      hasActiveFilters={false}
      onReset={vi.fn()}
      filters={<span>Node filter</span>}
    />
  );
  expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute("aria-expanded", "false");
});
