import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type HTMLAttributes, type ReactNode, useState } from "react";
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
  it("can show every option on focus while retaining free-text input", async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        freeText
        showAllOptionsOnFocus
        value="alpha"
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ]}
        onValueChange={vi.fn()}
        ariaLabel="Target"
      />
    );

    const input = screen.getByRole("combobox", { name: "Target" });
    expect(input).toHaveValue("alpha");
    await user.click(input);

    expect(input).toHaveValue("alpha");
    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  });

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

  it("keeps unmatched free text and shows the empty state", async () => {
    const user = userEvent.setup();
    function ControlledCombobox() {
      const [value, setValue] = useState("");
      return (
        <Combobox
          freeText
          value={value}
          options={[{ value: "example.com", label: "example.com" }]}
          onValueChange={setValue}
          emptyMessage="No matching domains."
          ariaLabel="Domain"
        />
      );
    }
    render(<ControlledCombobox />);

    const input = screen.getByRole("combobox", { name: "Domain" });
    await user.click(input);
    await user.type(input, "new.example");

    expect(input).toHaveValue("new.example");
    expect(screen.getByText("No matching domains.")).toBeInTheDocument();

    fireEvent.blur(input);
    expect(input).toHaveValue("new.example");
  });

  it("reopens on click when the input remains focused after a selection", async () => {
    const user = userEvent.setup();
    function ControlledCombobox() {
      const [value, setValue] = useState("");
      return (
        <Combobox
          value={value}
          options={[
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
          ]}
          onValueChange={setValue}
          ariaLabel="Environment"
        />
      );
    }
    render(<ControlledCombobox />);

    const input = screen.getByRole("combobox", { name: "Environment" });
    await user.click(input);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Alpha" }));

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");

    await user.click(input);

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  });

  it("preserves option group headings while filtering", async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        freeText
        value=""
        options={[
          { value: "automatic", label: "Automatic", group: "Address mode" },
          { value: "192.168.1.2", label: "192.168.1.2", group: "Local addresses" },
          { value: "8.8.8.8", label: "8.8.8.8", group: "Detected public addresses" },
        ]}
        onValueChange={vi.fn()}
        ariaLabel="Service address"
      />
    );

    const input = screen.getByRole("combobox", { name: "Service address" });
    await user.click(input);
    expect(screen.getByText("Address mode")).toBeInTheDocument();
    expect(screen.getByText("Local addresses")).toBeInTheDocument();
    expect(screen.getByText("Detected public addresses")).toBeInTheDocument();

    await user.type(input, "8.8");
    expect(screen.queryByText("Address mode")).not.toBeInTheDocument();
    expect(screen.queryByText("Local addresses")).not.toBeInTheDocument();
    expect(screen.getByText("Detected public addresses")).toBeInTheDocument();
  });
});
