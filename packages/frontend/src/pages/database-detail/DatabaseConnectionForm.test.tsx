import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildDatabasePayload,
  canCreateDatabase,
  DatabaseConnectionForm,
  draftFromConnection,
} from "./DatabaseConnectionForm";

describe("DatabaseConnectionForm", () => {
  it("shows credential fields without mixing in the URI field by default", () => {
    render(<DatabaseConnectionForm draft={draftFromConnection(null)} onChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "Connection method" })).toHaveTextContent(
      "Credentials"
    );
    expect(screen.getByText("Host")).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Primary Postgres")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Optional description")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("db.example.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("app")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("gateway")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter password")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Connection URI" })).not.toBeInTheDocument();
  });

  it("shows only the URI connection fields in URI mode", () => {
    render(
      <DatabaseConnectionForm
        draft={{
          ...draftFromConnection(null),
          type: "clickhouse",
          connectionMethod: "uri",
        }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox", { name: "Connection method" })).toHaveTextContent(
      "Connection URI"
    );
    expect(screen.getByRole("textbox", { name: "Connection URI" })).toHaveAttribute(
      "placeholder",
      "https://user:password@clickhouse.example.com:8443?database=analytics"
    );
    expect(screen.queryByText("Host")).not.toBeInTheDocument();
    expect(screen.queryByText("Password")).not.toBeInTheDocument();
    expect(screen.queryByText("TLS / SSL")).not.toBeInTheDocument();
  });

  it("shows the manual size limit only for Postgres metadata", () => {
    const postgres = draftFromConnection(null);
    const { rerender } = render(
      <DatabaseConnectionForm draft={postgres} onChange={vi.fn()} mode="metadata" />
    );

    expect(screen.getByText("Size Limit (MB)")).toBeInTheDocument();

    rerender(
      <DatabaseConnectionForm
        draft={{ ...postgres, type: "clickhouse" }}
        onChange={vi.fn()}
        mode="metadata"
      />
    );

    expect(screen.queryByText("Size Limit (MB)")).not.toBeInTheDocument();
  });

  it("shows the interactive query budget for SQL databases", () => {
    render(
      <DatabaseConnectionForm
        draft={draftFromConnection(null)}
        onChange={vi.fn()}
        mode="metadata"
      />
    );

    expect(screen.getByLabelText("Interactive query budget")).toHaveValue(300);
  });
});

describe("buildDatabasePayload", () => {
  it.each([
    ["postgres", "postgresql://user:secret@db.example.com:5432/app"],
    ["clickhouse", "https://user:secret@clickhouse.example.com:8443?database=analytics"],
    ["redis", "rediss://:secret@redis.example.com:6379/2"],
  ] as const)("sends only connectionString for %s URI mode", (type, connectionString) => {
    const payload = buildDatabasePayload({
      ...draftFromConnection(null),
      type,
      connectionMethod: "uri",
      connectionString: `  ${connectionString}  `,
      host: "hidden.example.com",
      port: "9999",
      database: "hidden_database",
      username: "hidden_user",
      password: "hidden_password",
      db: "7",
      sslEnabled: true,
      tlsEnabled: true,
    });

    expect(payload.config).toEqual({ connectionString });
  });

  it("sends only individual fields in credentials mode", () => {
    const payload = buildDatabasePayload({
      ...draftFromConnection(null),
      name: "Primary",
      connectionMethod: "credentials",
      connectionString: "postgresql://hidden:hidden@hidden:5432/hidden",
      host: "db.example.com",
      port: "5432",
      database: "app",
      username: "gateway",
      password: "secret",
      sslEnabled: true,
    });

    expect(payload.config).toEqual({
      host: "db.example.com",
      port: 5432,
      database: "app",
      username: "gateway",
      password: "secret",
      sslEnabled: true,
    });
  });

  it("does not send a manual size limit for ClickHouse", () => {
    const payload = buildDatabasePayload({
      ...draftFromConnection(null),
      type: "clickhouse",
      manualSizeLimitMb: "2048",
    });

    expect(payload).not.toHaveProperty("manualSizeLimitMb");
  });

  it("sends the configured interactive query budget for SQL databases", () => {
    const payload = buildDatabasePayload({
      ...draftFromConnection(null),
      interactiveQueryBudgetSeconds: "450",
    });

    expect(payload).toHaveProperty("interactiveQueryBudgetSeconds", 450);
  });
});

describe("canCreateDatabase", () => {
  it("requires a name and complete credential fields", () => {
    const draft = {
      ...draftFromConnection(null),
      name: "Primary",
      host: "db.example.com",
      database: "app",
      username: "gateway",
      password: "secret",
    };

    expect(canCreateDatabase(draft)).toBe(true);
    expect(canCreateDatabase({ ...draft, name: "" })).toBe(false);
    expect(canCreateDatabase({ ...draft, password: "" })).toBe(false);
    expect(canCreateDatabase({ ...draft, port: "70000" })).toBe(false);
  });

  it.each([
    ["postgres", "postgresql://user:secret@db.example.com:5432/app"],
    ["clickhouse", "https://user:secret@clickhouse.example.com:8443?database=analytics"],
    ["redis", "rediss://default:secret@redis.example.com:6379/2"],
  ] as const)("accepts a complete %s connection URI", (type, connectionString) => {
    expect(
      canCreateDatabase({
        ...draftFromConnection(null),
        name: "Primary",
        type,
        connectionMethod: "uri",
        connectionString,
      })
    ).toBe(true);
  });

  it("rejects incomplete or provider-mismatched connection URIs", () => {
    const draft = {
      ...draftFromConnection(null),
      name: "Primary",
      connectionMethod: "uri" as const,
    };

    expect(canCreateDatabase({ ...draft, connectionString: "" })).toBe(false);
    expect(
      canCreateDatabase({
        ...draft,
        connectionString: "postgresql://user@db.example.com:5432/app",
      })
    ).toBe(false);
    expect(
      canCreateDatabase({
        ...draft,
        connectionString: "redis://default:secret@redis.example.com:6379/0",
      })
    ).toBe(false);
  });
});
