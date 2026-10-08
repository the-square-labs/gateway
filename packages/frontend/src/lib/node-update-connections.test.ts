import { describe, expect, it } from "vitest";
import { describeCut, updateConnectionsSummary } from "./node-update-connections";

describe("update connections summary", () => {
  it("says connections are cut once without the handover capability or while handover is unavailable", () => {
    const report = { handoverAvailable: true, kept: 12, cut: {} };
    expect(updateConnectionsSummary(false, report).text).toBe("Open connections are cut once");
    expect(updateConnectionsSummary(true, { ...report, handoverAvailable: false }).text).toBe(
      "Open connections are cut once"
    );
    expect(updateConnectionsSummary(true, undefined).text).toBe("Open connections are cut once");
  });

  it("keeps connections when nothing would be cut", () => {
    expect(
      updateConnectionsSummary(true, { handoverAvailable: true, kept: 40, cut: { raw_stream: 0 } })
    ).toEqual({ text: "The update keeps connections", detail: null });
  });

  it("names older peers when only their raw streams are cut, the classes otherwise", () => {
    expect(
      updateConnectionsSummary(true, { handoverAvailable: true, kept: 3, cut: { raw_stream: 2 } })
    ).toEqual({ text: "2 connections will be cut (older peers)", detail: null });
    expect(
      updateConnectionsSummary(true, {
        handoverAvailable: true,
        kept: 3,
        cut: { raw_stream: 1, backup: 2, new_class: 1 },
      })
    ).toEqual({
      text: "4 connections will be cut",
      detail: "backup runs: 2, raw streams of older peers: 1, new class: 1",
    });
    expect(describeCut({ registry: 1 })).toBe("registry pulls and pushes: 1");
  });
});
