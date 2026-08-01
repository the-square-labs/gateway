import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ClickHouseConfigField } from "./ClickHouseConfigField";

describe("ClickHouseConfigField", () => {
  it("keeps the compact fragment field plain and opens the XML editor in a dialog", async () => {
    const user = userEvent.setup();
    render(
      <ClickHouseConfigField
        value="<clickhouse><max_threads>8</max_threads></clickhouse>"
        onChange={() => undefined}
      />
    );

    expect(
      screen.getByText("<clickhouse><max_threads>8</max_threads></clickhouse>")
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Expand ClickHouse configuration editor" })
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "ClickHouse configuration fragment" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });
});
