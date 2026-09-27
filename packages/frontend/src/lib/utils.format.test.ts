import { formatDate, formatDateTime, formatRelativeDate } from "./utils";

describe("date formats", () => {
  const now = new Date(2026, 8, 26, 15, 30);

  it("formats calendar dates and exact moments in en-GB order with 24-hour time", () => {
    expect(formatDate(new Date(2026, 1, 6, 9, 5))).toBe("06 Feb 2026");
    expect(formatDateTime(new Date(2026, 8, 6, 7, 47))).toBe("06 Sep 2026, 07:47");
  });

  it("shows a dash for a missing or invalid value", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatRelativeDate("not a date", now)).toBe("—");
  });

  it("shows past events within a week as relative time", () => {
    expect(formatRelativeDate(new Date(2026, 8, 26, 15, 29, 30), now)).toBe("Just now");
    expect(formatRelativeDate(new Date(2026, 8, 26, 15, 16), now)).toBe("14m ago");
    expect(formatRelativeDate(new Date(2026, 8, 26, 12, 10), now)).toBe("3h ago");
    expect(formatRelativeDate(new Date(2026, 8, 24, 15, 0), now)).toBe("2d ago");
  });

  it("shows older events this year with the time and earlier years with the year", () => {
    expect(formatRelativeDate(new Date(2026, 5, 16, 15, 32), now)).toBe("16 Jun 15:32");
    expect(formatRelativeDate(new Date(2025, 9, 16, 15, 32), now)).toBe("16 Oct 2025");
  });

  it("accepts epoch milliseconds", () => {
    expect(formatRelativeDate(now.getTime() - 5 * 60_000, now)).toBe("5m ago");
  });
});
