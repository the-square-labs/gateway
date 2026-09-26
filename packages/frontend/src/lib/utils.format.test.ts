import { formatDateTime, formatTimeOrDateTime } from "./utils";

describe("formatTimeOrDateTime", () => {
  const now = new Date(2026, 8, 26, 15, 30);

  it("shows only the time of day for a moment today", () => {
    expect(formatTimeOrDateTime(new Date(2026, 8, 26, 9, 5), now)).toBe("09:05");
  });

  it("shows the date and time for an earlier day", () => {
    const yesterday = new Date(2026, 8, 25, 23, 50);
    expect(formatTimeOrDateTime(yesterday, now)).toBe(formatDateTime(yesterday));
    expect(formatTimeOrDateTime(yesterday, now)).toContain("2026");
  });
});
