import { describe, expect, it } from "vitest";
import { formatDateTime } from "./utils";

describe("date formatting", () => {
  it("formats full timestamps day-first with a 24-hour clock", () => {
    const value = formatDateTime("2026-07-29T12:42:00.000Z");

    expect(value).toMatch(/^\d{2} Jul 2026, \d{2}:\d{2}$/);
    expect(value).not.toMatch(/AM|PM/i);
  });
});
