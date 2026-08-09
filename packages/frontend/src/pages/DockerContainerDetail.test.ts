import { describe, expect, it } from "vitest";
import {
  buildContainerMutationSnapshot,
  shouldSettleMutationTransition,
} from "./DockerContainerDetail";
import {
  containerArchiveCapabilities,
  containerLifecycleActions,
  STATUS_BADGE,
} from "./docker-detail/helpers";

function makeContainer(overrides: Record<string, unknown> = {}) {
  return {
    Id: "container-1",
    Mounts: [],
    Config: {
      Image: "registry.example.com/app:latest",
      Env: ["FOO=bar"],
      Entrypoint: ["/entrypoint.sh"],
      Cmd: ["node", "server.js"],
      WorkingDir: "/app",
      User: "node",
      Hostname: "app",
      Labels: { service: "backend" },
    },
    HostConfig: {
      PortBindings: { "3000/tcp": [{ HostIp: "", HostPort: "3000" }] },
      RestartPolicy: { Name: "always" },
      Memory: 256 * 1048576,
      MemorySwap: 512 * 1048576,
      NanoCPUs: 2 * 1e9,
      CpuShares: 512,
      PidsLimit: 64,
    },
    State: {
      Status: "running",
    },
    ...overrides,
  };
}

describe("DockerContainerDetail mutation snapshot helpers", () => {
  it("does not settle when the inspected container payload is unchanged", () => {
    const before = makeContainer();
    const signature = buildContainerMutationSnapshot(before);

    expect(shouldSettleMutationTransition(signature, makeContainer())).toBe(false);
  });

  it("settles when the inspected payload changes after a mutation", () => {
    const before = makeContainer();
    const signature = buildContainerMutationSnapshot(before);

    expect(
      shouldSettleMutationTransition(
        signature,
        makeContainer({
          HostConfig: {
            ...before.HostConfig,
            Memory: 512 * 1048576,
          },
        })
      )
    ).toBe(true);
  });

  it("settles immediately when the backend reports an active transition", () => {
    const signature = buildContainerMutationSnapshot(makeContainer());

    expect(
      shouldSettleMutationTransition(signature, {
        ...makeContainer(),
        _transition: "updating",
      })
    ).toBe(true);
  });
});

describe("DockerContainerDetail lifecycle actions", () => {
  it("renders migrating as a pending warning status", () => {
    expect(STATUS_BADGE.migrating).toBe("warning");
  });

  it("allows stop and kill while a container is crash-loop restarting", () => {
    expect(containerLifecycleActions("restarting")).toEqual({
      canStart: false,
      canStop: true,
      canRestart: false,
      canKill: true,
    });
  });

  it("allows starting, but not stopping or killing, an exited container", () => {
    expect(containerLifecycleActions("exited")).toEqual({
      canStart: true,
      canStop: false,
      canRestart: false,
      canKill: false,
    });
  });
});

describe("DockerContainerDetail archive permissions", () => {
  it("allows a registry archive with export access and gates portable data independently", () => {
    expect(
      containerArchiveCapabilities({ export: true, files: true, environment: true, secrets: false })
    ).toEqual({
      canExport: true,
      canExportPortable: true,
      canIncludeEnvironment: true,
      canIncludeSecrets: false,
    });
    expect(
      containerArchiveCapabilities({
        export: true,
        files: false,
        environment: false,
        secrets: true,
      })
    ).toEqual({
      canExport: true,
      canExportPortable: false,
      canIncludeEnvironment: false,
      canIncludeSecrets: false,
    });
  });
});
