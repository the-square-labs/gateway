import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import {
  ensureManagedMountVolumes,
  type MountEntry,
  VolumeMountsSection,
} from "./VolumeMountsSection";

const mounts: MountEntry[] = [
  {
    hostPath: "/srv/app/config",
    containerPath: "/config",
    name: "",
    readOnly: true,
  },
];

function renderSection(canEdit: boolean) {
  return render(
    <VolumeMountsSection
      nodeId="node-1"
      canEdit={canEdit}
      mounts={mounts}
      setMounts={vi.fn()}
      mountsChanged={false}
      inputCell="h-9"
    />
  );
}

describe("VolumeMountsSection", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps existing mounts visible but readonly without mount permission", () => {
    renderSection(false);

    expect(screen.getByDisplayValue("/srv/app/config")).toBeDisabled();
    expect(screen.getByDisplayValue("/config")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /add/i })).not.toBeInTheDocument();
  });

  it("allows mount editing when mount permission is available", () => {
    renderSection(true);

    expect(screen.getByDisplayValue("/srv/app/config")).not.toBeDisabled();
    expect(screen.getByDisplayValue("/config")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /add/i })).toBeInTheDocument();
  });

  it("creates a free-text managed volume before attaching it", async () => {
    vi.spyOn(api, "listManagedVolumeOptions").mockResolvedValue([]);
    const create = vi.spyOn(api, "createVolume").mockResolvedValue({});

    await ensureManagedMountVolumes(
      "node-1",
      [{ hostPath: "", containerPath: "/data", name: "app-data", readOnly: false }],
      []
    );

    expect(create).toHaveBeenCalledWith("node-1", { name: "app-data" });
  });

  it("does not recreate an unchanged legacy volume", async () => {
    const list = vi.spyOn(api, "listManagedVolumeOptions");
    const legacy = [{ hostPath: "", containerPath: "/data", name: "legacy", readOnly: false }];

    await ensureManagedMountVolumes("node-1", legacy, legacy);

    expect(list).not.toHaveBeenCalled();
  });
});
