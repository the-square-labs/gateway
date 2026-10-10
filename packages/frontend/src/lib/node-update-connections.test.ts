import { describe, expect, it } from "vitest";
import {
  describeCut,
  lastUpdateConnectionsText,
  launcherVersionUnknownReason,
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

describe("last update connections", () => {
  it("counts what the update kept and cut", () => {
    expect(lastUpdateConnectionsText({ kept: 61, cut: {} })).toBe("Kept 61, cut 0");
    expect(lastUpdateConnectionsText({ kept: 0, cut: { service_restart: 22 } })).toBe(
      "Kept 0, cut 22: all connections of the node (the whole service restarted for the newer launcher)"
    );
  });

  it("says all connections when the previous daemon did not count them", () => {
    expect(lastUpdateConnectionsText({ kept: 0, cut: { uncounted: 1 } })).toBe(
      "Kept 0, cut all connections of the node: the previous daemon version can't hand them over"
    );
  });

  it("adds the service restart right after an update that cut all connections", () => {
    expect(lastUpdateConnectionsText({ kept: 0, cut: { uncounted: 1, service_restart: 12 } })).toBe(
      "Kept 0, cut all connections of the node: the previous daemon version can't hand them over; the whole service then restarted once for the newer launcher and cut 12"
    );
  });
});

describe("launcher version unknown reason", () => {
  it("names a launcher that predates self-update", () => {
    expect(
      launcherVersionUnknownReason(["docker_compose_v1", "launcher_listener_keep_v1"])
    ).toMatch(/^Started before 2\.11\.4: this launcher predates launcher self-update/);
  });

  it("names an older daemon when nothing about the launcher is reported", () => {
    expect(launcherVersionUnknownReason(undefined)).toMatch(/^Not reported/);
    expect(launcherVersionUnknownReason(["docker_compose_v1"])).toMatch(/^Not reported/);
  });
});
