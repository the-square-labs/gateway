import { describe, expect, it, vi } from "vitest";
import {
  buildAuditExportFilename,
  formatAuditExport,
  formatAuditToken,
  getAuditEntryUserKey,
  getAuditEntryUserLabel,
  mergeAuditFilterUsers,
  mergeAuditFilterValues,
} from "@/pages/audit-log/audit-format";
import type { AuditLogEntry } from "@/types";

const baseEntry: AuditLogEntry = {
  id: "audit-1",
  userId: "user-1",
  action: "docker.container.create",
  resourceType: "docker-container",
  resourceId: "container-1",
  details: { image: "registry.example.com/team/api:latest", note: "needs,quotes" },
  ipAddress: "127.0.0.1",
  userAgent: "Vitest",
  createdAt: "2026-06-21T08:30:00.000Z",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  userAvatarUrl: "/auth/avatars/11111111-1111-4111-8111-111111111111.webp",
};

describe("AuditLog helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats audit tokens and user fallbacks", () => {
    expect(formatAuditToken("docker.container-live_update")).toBe("Docker Container Live Update");
    expect(getAuditEntryUserKey({ ...baseEntry, userId: null })).toBe("system");
    expect(
      getAuditEntryUserLabel({
        ...baseEntry,
        userId: null,
        userName: null,
        userEmail: null,
      })
    ).toBe("System");
    expect(
      getAuditEntryUserLabel({
        ...baseEntry,
        userName: null,
        userEmail: "fallback@example.com",
      })
    ).toBe("fallback@example.com");
  });

  it("formats audit exports without losing escaping semantics", () => {
    const entry = {
      ...baseEntry,
      action: "database.postgres.query",
      details: { sql: 'select "name", count(*) from users', rows: 2 },
    };

    const csv = formatAuditExport([entry], "csv");
    expect(csv.type).toBe("text/csv;charset=utf-8");
    expect(csv.content).toContain("Time,User,User ID,Action,Resource Type");
    expect(csv.content).toContain("database.postgres.query");
    expect(csv.content).toContain(
      '"{""sql"":""select \\""name\\"", count(*) from users"",""rows"":2}"'
    );

    const tsv = formatAuditExport([entry], "tsv");
    expect(tsv.type).toBe("text/tab-separated-values;charset=utf-8");
    expect(tsv.content).toContain("Time\tUser\tUser ID\tAction");
    expect(tsv.content).not.toContain("\nselect");

    const text = formatAuditExport([entry], "txt");
    expect(text.type).toBe("text/plain;charset=utf-8");
    expect(text.content).toContain("Action: database.postgres.query");
    expect(text.content).toContain("Details: ");

    const html = formatAuditExport([entry], "html");
    expect(html.type).toBe("text/html;charset=utf-8");
    expect(html.content).toContain("<h1>Gateway Audit Log</h1>");
    expect(html.content).toContain("{&quot;sql&quot;");
    expect(html.content).toContain("count(*) from users");
  });

  it("neutralizes spreadsheet formulas in delimited audit exports", () => {
    const entry = {
      ...baseEntry,
      action: '=HYPERLINK("https://attacker.example")',
      userName: "\t+SUM(1,1)",
    };

    const csv = formatAuditExport([entry], "csv");
    expect(csv.content).toContain("'=HYPERLINK");

    const tsv = formatAuditExport([entry], "tsv");
    expect(tsv.content).toContain("' +SUM(1,1)");
  });

  it("builds timestamped export filenames", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T08:30:00.123Z"));

    expect(buildAuditExportFilename("csv")).toBe("gateway-audit-log-2026-06-21T08-30-00-123Z.csv");
  });

  it("keeps audit filter options stable while new pages and filters load", () => {
    expect(mergeAuditFilterValues(["z.action", "a.action"], ["m.action", "a.action"])).toEqual([
      "a.action",
      "m.action",
      "z.action",
    ]);
    expect(
      mergeAuditFilterUsers(
        [
          { id: "user-2", label: "Zoe" },
          { id: "user-1", label: "Old label" },
        ],
        [
          { id: "user-1", label: "Ada" },
          { id: "user-3", label: "Linus" },
        ]
      )
    ).toEqual([
      { id: "user-1", label: "Ada" },
      { id: "user-3", label: "Linus" },
      { id: "user-2", label: "Zoe" },
    ]);
  });
});
