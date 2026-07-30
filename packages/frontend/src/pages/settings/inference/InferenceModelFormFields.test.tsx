import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { PermissionGroup, User } from "@/types";
import type { InferenceAccessSubject } from "@/types/inference";
import { ModelAccessFields } from "./InferenceModelFormFields";

describe("ModelAccessFields", () => {
  it("manages selected users and groups with the proxy-host row pattern", async () => {
    const user = userEvent.setup();
    render(<AccessHarness />);

    const firstSubject = screen.getByRole("combobox", { name: "Group 1" });
    const accessPanel = screen.getByText("Model access").closest(".border");
    expect(accessPanel).toContainElement(screen.getByRole("combobox", { name: "Access" }));
    expect(accessPanel).toContainElement(firstSubject);
    expect(screen.getByText("Subject type")).toBeInTheDocument();
    expect(screen.getByText("User or group")).toBeInTheDocument();
    const addSubject = screen.getByRole("button", { name: "Add access subject" });
    expect(accessPanel).toContainElement(addSubject);
    expect(addSubject).toBeDisabled();

    await user.click(firstSubject);
    await user.click(screen.getByRole("button", { name: "Operators" }));
    expect(screen.getByTestId("subjects")).toHaveTextContent(
      '[{"subjectType":"group","subjectId":"group-1"}]'
    );

    await user.click(screen.getByRole("button", { name: "Add access subject" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Subject type 2" }), {
      key: "ArrowDown",
    });
    await user.click(screen.getByRole("option", { name: "User" }));
    await user.click(screen.getByRole("combobox", { name: "User 2" }));
    await user.click(screen.getByRole("button", { name: "Alice" }));

    expect(screen.getByTestId("subjects")).toHaveTextContent(
      '[{"subjectType":"group","subjectId":"group-1"},{"subjectType":"user","subjectId":"user-1"}]'
    );

    await user.click(screen.getByRole("button", { name: "Remove access subject 1" }));
    expect(screen.getByTestId("subjects")).toHaveTextContent(
      '[{"subjectType":"user","subjectId":"user-1"}]'
    );
  });
});

function AccessHarness() {
  const [mode, setMode] = useState<"everyone" | "selected" | "disabled">("selected");
  const [subjects, setSubjects] = useState<InferenceAccessSubject[]>([]);

  return (
    <>
      <ModelAccessFields
        mode={mode}
        setMode={setMode}
        subjects={subjects}
        setSubjects={setSubjects}
        groups={[group()]}
        users={[gatewayUser()]}
      />
      <output data-testid="subjects">{JSON.stringify(subjects)}</output>
    </>
  );
}

function group(): PermissionGroup {
  return {
    id: "group-1",
    name: "Operators",
    description: null,
    isBuiltin: false,
    parentId: null,
    scopes: [],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

function gatewayUser(): User {
  return {
    id: "user-1",
    oidcSubject: "alice",
    email: "alice@example.com",
    name: "Alice",
    avatarUrl: null,
    groupId: "group-1",
    groupName: "Operators",
    scopes: [],
    isBlocked: false,
  };
}
