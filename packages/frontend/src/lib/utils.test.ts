import { describe, expect, it } from "vitest";
import { formatBytes, formatDateTime } from "./utils";

describe("date formatting", () => {
  it("formats full timestamps day-first with a 24-hour clock", () => {
    const value = formatDateTime("2026-07-29T12:42:00.000Z");

    expect(value).toMatch(/^\d{2} Jul 2026, \d{2}:\d{2}$/);
    expect(value).not.toMatch(/AM|PM/i);
  });
});

describe("byte formatting", () => {
  it("keeps sub-byte rates in the base unit", () => {
    expect(formatBytes(0.8667)).toBe("0.9 B");
  });

  it("never exposes an invalid or missing unit", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});
