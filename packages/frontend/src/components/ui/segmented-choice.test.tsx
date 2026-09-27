import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { SegmentedChoice } from "./segmented-choice";

function RuleAction() {
  const [value, setValue] = useState<"allow" | "deny">("allow");
  return (
    <SegmentedChoice
      aria-label="Rule action"
      value={value}
      options={[
        { value: "allow", label: "Allow", tone: "success" },
        { value: "deny", label: "Deny", tone: "destructive" },
      ]}
      onChange={setValue}
    />
  );
}

it("works as a radio group with a single tab stop and arrow keys", async () => {
  const user = userEvent.setup();
  render(<RuleAction />);

  expect(screen.getByRole("radiogroup", { name: "Rule action" })).toBeInTheDocument();
  const allow = screen.getByRole("radio", { name: "Allow" });
  const deny = screen.getByRole("radio", { name: "Deny" });
  expect(allow).toHaveAttribute("aria-checked", "true");
  expect(deny).toHaveAttribute("tabindex", "-1");

  await user.tab();
  expect(allow).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(deny).toHaveAttribute("aria-checked", "true");
  expect(deny).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(allow).toHaveAttribute("aria-checked", "true");

  await user.click(deny);
  expect(deny).toHaveAttribute("aria-checked", "true");
  expect(allow).toHaveAttribute("tabindex", "-1");
});
