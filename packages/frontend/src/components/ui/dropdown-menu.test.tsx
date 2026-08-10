import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function TestDropdown() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Menu item</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenu focus restoration", () => {
  it("does not leave the trigger focused after a pointer selection", async () => {
    const user = userEvent.setup();
    render(<TestDropdown />);

    const trigger = screen.getByRole("button", { name: "Open menu" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Menu item" }));

    expect(trigger).not.toHaveFocus();
  });

  it("restores focus to the trigger after keyboard dismissal", async () => {
    const user = userEvent.setup();
    render(<TestDropdown />);

    const trigger = screen.getByRole("button", { name: "Open menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");

    expect(trigger).toHaveFocus();
  });
});
