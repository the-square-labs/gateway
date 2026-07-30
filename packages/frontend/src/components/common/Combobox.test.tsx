import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HTMLAttributes, ReactNode } from "react";
import { vi } from "vitest";
import { Combobox } from "./Combobox";

vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  const OpenContext = React.createContext(false);

  return {
    Popover: ({ open, children }: { open: boolean; children: ReactNode }) => (
      <OpenContext.Provider value={open}>{children}</OpenContext.Provider>
    ),
    PopoverAnchor: ({ children }: { children: ReactNode }) => children,
    PopoverContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => {
      const open = React.useContext(OpenContext);
      return (
        <div {...props} data-state={open ? "open" : "closed"}>
          {children}
        </div>
      );
    },
  };
});

describe("Combobox", () => {
  it("keeps the filtered options until the close animation finishes", async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        value=""
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
          { value: "gamma", label: "Gamma" },
        ]}
        onValueChange={vi.fn()}
        ariaLabel="Model"
      />
    );

    const input = screen.getByRole("combobox", { name: "Model" });
    await user.click(input);
    await user.type(input, "alp");

    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });

    const dropdown = screen.getByText("Alpha").closest<HTMLElement>(".dropdown-content");
    expect(dropdown).toHaveAttribute("data-state", "closed");
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument();

    fireEvent.animationEnd(dropdown!);

    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  });
});
