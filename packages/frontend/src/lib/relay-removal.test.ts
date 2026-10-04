import { describe, expect, it } from "vitest";
import { relayRemovalWaitNote } from "./relay-removal";
import { formatDateTime } from "./utils";

const NOW = Date.parse("2026-10-04T12:00:00Z");

describe("relayRemovalWaitNote", () => {
  it("names the local time an offline relay can be removed after", () => {
    const removableAfter = "2026-10-05T08:30:00.000Z";
    expect(relayRemovalWaitNote({ state: "offline", removableAfter }, NOW)).toBe(
      `Can be removed after ${formatDateTime(removableAfter)}`
    );
  });

  it("has nothing to say once removal is possible or for a relay that is not offline", () => {
    expect(
      relayRemovalWaitNote({ state: "offline", removableAfter: "2026-10-04T11:59:00.000Z" }, NOW)
    ).toBeNull();
    expect(relayRemovalWaitNote({ state: "offline", removableAfter: null }, NOW)).toBeNull();
    expect(
      relayRemovalWaitNote({ state: "draining", removableAfter: "2026-10-05T08:30:00.000Z" }, NOW)
    ).toBeNull();
  });
});
