import { describe, expect, it } from "vitest";
import {
  describeCut,
  updateConnectionsPlacement,
  updateConnectionsSummary,
} from "./node-update-connections";

describe("update connections summary", () => {
  it("says connections are cut once without the handover capability or while handover is unavailable, and why", () => {
    const report = { handoverAvailable: true, kept: 12, cut: {} };
    expect(updateConnectionsSummary(false, report)).toEqual({
      text: "Open connections are cut once",
      detail: "This daemon version cannot hand connections over",
    });
    expect(
      updateConnectionsSummary(true, {
        ...report,
        handoverAvailable: false,
        cut: { service_restart: 4 },
      })
    ).toEqual({
      text: "Open connections are cut once",
      detail: "The whole service restarts once to start the newer launcher",
    });
    expect(
      updateConnectionsSummary(true, {
        ...report,
        handoverAvailable: false,
        cut: { no_handover: 2 },
      })
    ).toEqual({
      text: "Open connections are cut once",
      detail: "connections that cannot be handed over: 2",
    });
    expect(updateConnectionsSummary(true, { ...report, handoverAvailable: false })).toEqual({
      text: "Open connections are cut once",
      detail: "The launcher running now cannot keep them",
    });
  });

  it("does not guess before the node reported it", () => {
    expect(updateConnectionsSummary(true, undefined)).toEqual({
      text: "Not reported yet",
      detail: "The node reports it while it is connected",
    });
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

  it("is shown in the Runtime panel when no update panel shows it, also with no update available (O-4)", () => {
    expect(updateConnectionsPlacement("docker", false)).toBe("runtime");
    expect(updateConnectionsPlacement("nginx", false)).toBe("runtime");
    expect(updateConnectionsPlacement("docker", true)).toBe("update-panel");
    expect(updateConnectionsPlacement("monitoring", false)).toBeNull();
    expect(updateConnectionsPlacement("relay", true)).toBeNull();
  });
});
