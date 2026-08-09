import { describe, expect, it } from "vitest";
import { buildRecreatePayloadFromForm } from "./SettingsTab";

describe("buildRecreatePayloadFromForm", () => {
  const recreateBaseline = {
    imageTag: "latest",
    ports: "[]",
    mounts: "[]",
    entrypoint: "",
    command: "",
    stopTimeout: "10",
    workingDir: "/app",
    user: "node",
    hostname: "gateway",
    labels: "[]",
    gpuDeviceIds: "[]",
  };

  it("builds recreate payload with parsed execution fields and trimmed labels", () => {
    expect(
      buildRecreatePayloadFromForm({
        parsedImageName: "registry.example.com/team/app",
        imageTag: "release-1",
        imageTagChanged: true,
        portsChanged: false,
        ports: [],
        mountsChanged: false,
        mounts: [],
        entrypoint: '"/bin/sh" -lc',
        command: 'node "server.js"',
        stopTimeout: "15",
        workingDir: "/srv/app",
        user: "root",
        hostname: "gateway-next",
        labelsChanged: true,
        labels: [
          { key: " service ", value: "backend" },
          { key: "", value: "ignored" },
        ],
        gpuChanged: true,
        gpuDeviceIds: ["nvidia:GPU-1"],
        hasRuntimeChanges: true,
        runtimePayload: { restartPolicy: "always" },
        recreateBaseline,
      })
    ).toEqual({
      image: "registry.example.com/team/app:release-1",
      entrypoint: ["/bin/sh", "-lc"],
      command: ["node", "server.js"],
      stopTimeout: 15,
      workingDir: "/srv/app",
      user: "root",
      hostname: "gateway-next",
      labels: {
        service: "backend",
      },
      gpu: { deviceIds: ["nvidia:GPU-1"] },
      restartPolicy: "always",
    });
  });

  it("sends an explicit empty GPU selection to detach every managed GPU", () => {
    expect(
      buildRecreatePayloadFromForm({
        parsedImageName: "registry.example.com/team/app",
        imageTag: "latest",
        imageTagChanged: false,
        portsChanged: false,
        ports: [],
        mountsChanged: false,
        mounts: [],
        entrypoint: "",
        command: "",
        stopTimeout: "10",
        workingDir: "/app",
        user: "node",
        hostname: "gateway",
        labelsChanged: false,
        labels: [],
        gpuChanged: true,
        gpuDeviceIds: [],
        hasRuntimeChanges: false,
        runtimePayload: null,
        recreateBaseline,
      })
    ).toEqual({ gpu: { deviceIds: [] } });
  });

  it("preserves the selected publish address in recreated port mappings", () => {
    expect(
      buildRecreatePayloadFromForm({
        parsedImageName: "nginx",
        imageTag: "latest",
        imageTagChanged: false,
        portsChanged: true,
        ports: [{ hostIp: "127.0.0.1", hostPort: "8080", containerPort: "80", protocol: "tcp" }],
        mountsChanged: false,
        mounts: [],
        entrypoint: "",
        command: "",
        stopTimeout: "10",
        workingDir: "/app",
        user: "node",
        hostname: "gateway",
        labelsChanged: false,
        labels: [],
        gpuChanged: false,
        gpuDeviceIds: [],
        hasRuntimeChanges: false,
        runtimePayload: null,
        recreateBaseline,
      })
    ).toEqual({
      ports: [{ hostIp: "127.0.0.1", hostPort: 8080, containerPort: 80, protocol: "tcp" }],
    });
  });

  it("removes the tag suffix and clears entrypoint/command when values are blanked", () => {
    expect(
      buildRecreatePayloadFromForm({
        parsedImageName: "registry.example.com/team/app",
        imageTag: "",
        imageTagChanged: true,
        portsChanged: false,
        ports: [],
        mountsChanged: false,
        mounts: [],
        entrypoint: "   ",
        command: "",
        stopTimeout: "10",
        workingDir: "/app",
        user: "node",
        hostname: "gateway",
        labelsChanged: false,
        labels: [],
        gpuChanged: false,
        gpuDeviceIds: [],
        hasRuntimeChanges: false,
        runtimePayload: null,
        recreateBaseline: {
          ...recreateBaseline,
          entrypoint: "/docker-entrypoint.sh",
          command: "node index.js",
        },
      })
    ).toEqual({
      image: "registry.example.com/team/app",
      entrypoint: [],
      command: [],
    });
  });
});
