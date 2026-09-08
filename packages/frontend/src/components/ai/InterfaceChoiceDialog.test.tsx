import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Server } from "lucide-react";
import { vi } from "vitest";
import { InterfaceChoiceDialog } from "./InterfaceChoiceDialog";

it("preserves the original non-dismissible interface selection", async () => {
  const onAIWorkspace = vi.fn();
  const onOperationsConsole = vi.fn();
  render(
    <InterfaceChoiceDialog
      open
      busy={false}
      onAIWorkspace={onAIWorkspace}
      onOperationsConsole={onOperationsConsole}
    />
  );
  const user = userEvent.setup();
  expect(
    screen.getByRole("heading", { name: "Choose your Gateway interface" })
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^AI Workspace/ }));
  await user.click(screen.getByRole("button", { name: /^Operations Console/ }));
  expect(onAIWorkspace).toHaveBeenCalledOnce();
  expect(onOperationsConsole).toHaveBeenCalledOnce();
});

it("uses the same choice layout with custom content, busy protection and dismissal", async () => {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  render(
    <InterfaceChoiceDialog
      open
      busy
      onOpenChange={onOpenChange}
      title="Add Node"
      description="Choose a machine"
      choices={[
        { label: "External VM", description: "Enroll an existing host", icon: Server, onSelect },
      ]}
    />
  );
  const button = screen.getByRole("button", { name: /External VM/ });
  expect(button).toBeDisabled();
  expect(button).toHaveClass("h-auto", "w-full", "text-left");
  expect(button.querySelector("svg")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onSelect).not.toHaveBeenCalled();
});
