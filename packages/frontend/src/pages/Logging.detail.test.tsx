import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { LoggingEnvironmentDetail, LoggingSchemaDetail } from "@/pages/logging/LoggingDetails";
import { renderWithRouter } from "@/test/render";
import type { LoggingEnvironment, LoggingSchema } from "@/types";

vi.mock("./logging/LoggingExplorer", () => ({
  LoggingExplorer: () => <div data-testid="logging-explorer" />,
}));

vi.mock("./logging/LoggingTokenPanel", () => ({
  LoggingTokenPanel: () => <div data-testid="logging-token-panel" />,
}));

function makeSchema(overrides: Partial<LoggingSchema> = {}): LoggingSchema {
  return {
    id: "schema-1",
    name: "Payments",
    slug: "payments",
    description: "Payment events",
    schemaMode: "reject",
    fieldSchema: [],
    createdById: null,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<LoggingEnvironment> = {}): LoggingEnvironment {
  return {
    id: "env-1",
    name: "Production",
    slug: "production",
    description: "Production logs",
    enabled: true,
    schemaId: "schema-1",
    schemaName: "Payments",
    schemaMode: "reject",
    fieldSchema: [],
    retentionDays: 30,
    rateLimitRequestsPerWindow: 100,
    rateLimitEventsPerWindow: 1000,
    createdById: null,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("Logging detail views", () => {
  it("saves schema draft changes from the detail form", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    renderWithRouter(
      <LoggingSchemaDetail
        schema={makeSchema()}
        loading={false}
        canEdit={true}
        canDelete={false}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
      { path: "/logging/schemas/:id", route: "/logging/schemas/schema-1" }
    );

    const nameInput = screen.getByDisplayValue("Payments");
    await user.clear(nameInput);
    await user.type(nameInput, "Payments v2");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Payments v2",
          schemaMode: "reject",
        })
      );
      expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("slug");
    });
  });

  it("saves environment settings draft changes from the settings tab", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const environment = makeEnvironment();

    renderWithRouter(
      <LoggingEnvironmentDetail
        environment={environment}
        schemas={[makeSchema()]}
        loggingEnabled={true}
        loading={false}
        activeTab="settings"
        canEdit={true}
        canDelete={false}
        canCreateToken={false}
        canDeleteToken={false}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
      />,
      { path: "/logging/environments/:id/:tab", route: "/logging/environments/env-1/settings" }
    );

    const retentionInput = screen.getByDisplayValue("30");
    fireEvent.change(retentionInput, { target: { value: "45" } });
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        "env-1",
        expect.objectContaining({
          retentionDays: 45,
        })
      );
    });
  });

  it("uses standard settings spacing, placeholders, help, and accessible labels", () => {
    const { container } = renderWithRouter(
      <LoggingEnvironmentDetail
        environment={makeEnvironment({
          rateLimitRequestsPerWindow: null,
          rateLimitEventsPerWindow: null,
        })}
        schemas={[makeSchema()]}
        loggingEnabled={true}
        loading={false}
        activeTab="settings"
        canEdit={true}
        canDelete={false}
        canCreateToken={false}
        canDeleteToken={false}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
      { path: "/logging/environments/:id/:tab", route: "/logging/environments/env-1/settings" }
    );

    expect(container.querySelector(".lg\\:grid-cols-2")).toHaveClass("gap-4");
    expect(container.querySelector(".lucide-braces")).toBeInTheDocument();
    expect(container.querySelector(".lucide-gauge")).toBeInTheDocument();
    expect(screen.getByLabelText("Attached schema")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enabled" })).toBeInTheDocument();
    expect(screen.getByLabelText("Retention days")).toHaveAttribute("placeholder", "30");
    expect(screen.getByLabelText("Request limit")).toHaveAttribute(
      "placeholder",
      "Use token default"
    );
    expect(screen.getByLabelText("Event limit")).toHaveAttribute(
      "placeholder",
      "Use token default"
    );
    for (const label of [
      "Attached schema",
      "Mode",
      "Enabled",
      "Retention days",
      "Request limit",
      "Event limit",
    ]) {
      expect(screen.getByRole("button", { name: `About ${label}` })).toBeInTheDocument();
    }
  });

  it("shows animated SDK and API connection instructions from the environment header", async () => {
    const user = userEvent.setup();

    renderWithRouter(
      <LoggingEnvironmentDetail
        environment={makeEnvironment()}
        schemas={[makeSchema()]}
        loggingEnabled={true}
        loading={false}
        activeTab="logs"
        canEdit={false}
        canDelete={false}
        canCreateToken={false}
        canDeleteToken={false}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
      { path: "/logging/environments/:id/:tab", route: "/logging/environments/env-1/logs" }
    );

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Connect to this environment")).toBeInTheDocument();
    expect(screen.getByText("pnpm add @sqgateway/logger")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "API" }));

    expect(screen.getByText("/api/logging/ingest/batch")).toBeInTheDocument();
    expect(screen.getByText(/curl -X POST/)).toBeInTheDocument();
  });
});
