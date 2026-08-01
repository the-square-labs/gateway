import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DatabaseConnection } from "@/types";
import { DatabaseCredentialsDialog } from "./DatabaseCredentialsDialog";

const database = {
  id: "database-1",
  slug: "orders",
  name: "Orders",
  type: "postgres",
  description: null,
  tags: [],
  manualSizeLimitMb: null,
  host: "managed.gateway.internal",
  port: 5432,
  databaseName: "orders",
  username: "owner",
  tlsEnabled: false,
  healthStatus: "online",
  lastHealthCheckAt: null,
  lastError: null,
  hasStoredPassword: true,
  config: {
    host: "managed.gateway.internal",
    port: 5432,
    database: "orders",
    username: "owner",
    password: "••••••••",
    sslEnabled: false,
  },
  managed: {
    id: "managed-1",
    nodeId: "node-1",
    version: "17.5",
    storageSizeBytes: 1024,
    runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 0 },
    publishedPort: 15432,
    publishedNativePort: null,
    tlsEnabled: true,
    endpointHost: "database.example.test",
    status: "ready",
    lastError: null,
  },
  createdById: "user-1",
  updatedById: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as DatabaseConnection;

describe("DatabaseCredentialsDialog", () => {
  it("renders published managed credentials as labelled copyable fields", () => {
    render(
      <DatabaseCredentialsDialog
        database={database}
        credentials={{ username: "owner", password: "secret", databaseName: "orders" }}
        loading={false}
        open
        onOpenChange={() => undefined}
      />
    );

    expect(screen.getByLabelText("Connection URI")).toHaveValue(
      "postgresql://owner:secret@database.example.test:15432/orders?sslmode=verify-full"
    );
    expect(screen.getByLabelText("Host")).toHaveValue("database.example.test");
    expect(screen.getByLabelText("Port")).toHaveValue("15432");
    expect(screen.getByLabelText("Password")).toHaveValue("secret");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show Password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide Password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Connection URI" })).toBeInTheDocument();
  });

  it("offers the direct-access CA certificate as a PEM download", () => {
    render(
      <DatabaseCredentialsDialog
        database={database}
        credentials={{
          username: "owner",
          password: "secret",
          databaseName: "orders",
          caCertificate: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
        }}
        loading={false}
        open
        onOpenChange={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "Download CA certificate" })).toBeInTheDocument();
  });
});
