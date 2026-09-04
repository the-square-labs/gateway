import { describe, expect, it } from "vitest";
import { api } from "@/services/api";
import {
  buildContainerMutationSnapshot,
  hasContainerRuntimeIdentityChanged,
  inspectContainerAfterMutation,
  resolveComposeOwnerName,
  resolveContainerNameFromPathname,
  resolveContainerRouteName,
  shouldSettleMutationTransition,
  splitContainerAvailabilityPolicy,
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
  it("keeps the canonical Compose owner name when switching to a replica", () => {
    const policy = { resourceKind: "compose", displayName: "customer-app" } as any;
    expect(
      resolveComposeOwnerName(policy, {
        "com.docker.compose.project": "gwav-compose-policy-placement",
      })
    ).toBe("customer-app");
    expect(
      resolveComposeOwnerName(null, {
        "com.docker.compose.project": "ordinary-compose",
      })
    ).toBe("ordinary-compose");
  });
  it("never uses Compose or deployment placements as a standalone container runtime", () => {
    for (const resourceKind of ["compose", "deployment"] as const) {
      const policy = {
        resourceKind,
        mode: "replicated",
        placements: [{ nodeId: "other-node", runtimeIdentity: { containers: [] } }],
      } as any;
      expect(splitContainerAvailabilityPolicy(policy)).toEqual({ own: null, parent: policy });
    }
    const own = { resourceKind: "container" } as any;
    expect(splitContainerAvailabilityPolicy(own)).toEqual({ own, parent: null });
  });
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

  it("settles when attached networks change", () => {
    const before = makeContainer({ NetworkSettings: { Networks: { bridge: {} } } });
    const signature = buildContainerMutationSnapshot(before);

    expect(
      shouldSettleMutationTransition(signature, {
        ...before,
        NetworkSettings: { Networks: { bridge: {}, app: { NetworkID: "network-1" } } },
      })
    ).toBe(true);
  });

  it("keeps polling while the backend reports an active transition", () => {
    const signature = buildContainerMutationSnapshot(makeContainer());

    expect(
      shouldSettleMutationTransition(signature, {
        ...makeContainer(),
        _transition: "updating",
      })
    ).toBe(false);
  });
});

describe("DockerContainerDetail post-mutation identity recovery", () => {
  it("keeps the logical URL name when the resolved runtime has an internal Availability name", () => {
    expect(
      resolveContainerRouteName(
        "gwav-container-policy-placement",
        "availability-container",
        undefined
      )
    ).toBe("availability-container");
  });

  it("keeps the logical pathname name when route params remount with an internal runtime", () => {
    const pathnameName = resolveContainerNameFromPathname(
      "/docker/containers/e2e-docker-132/availability-container/overview"
    );

    expect(
      resolveContainerRouteName(
        "gwav-container-policy-placement",
        undefined,
        undefined,
        pathnameName
      )
    ).toBe("availability-container");
  });

  it("requires an immediate inspect refresh after adopting a replacement runtime id", () => {
    expect(hasContainerRuntimeIdentityChanged("container-2", makeContainer())).toBe(true);
    expect(
      hasContainerRuntimeIdentityChanged("container-2", makeContainer({ Id: "container-2" }))
    ).toBe(false);
  });

  it("falls back to the stable name when recreate invalidates the runtime ID", async () => {
    vi.spyOn(api, "inspectContainer").mockRejectedValueOnce(new Error("not found"));
    vi.spyOn(api, "inspectContainerByName").mockResolvedValueOnce(
      makeContainer({ Id: "container-2", Name: "/app" })
    );

    await expect(inspectContainerAfterMutation("node-1", "container-1", "app")).resolves.toEqual({
      container: makeContainer({ Id: "container-2", Name: "/app" }),
      containerId: "container-2",
    });
    expect(api.inspectContainerByName).toHaveBeenCalledWith("node-1", "app", true);
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

  it("keeps emergency kill available during transitional and unhealthy live states", () => {
    for (const state of ["updating", "recreating", "killing", "paused", "dead", "stopped"]) {
      expect(containerLifecycleActions(state).canKill).toBe(true);
    }
  });

  it("disables emergency kill only for created, exited, and offline states", () => {
    for (const state of ["created", "exited", "offline"]) {
      expect(containerLifecycleActions(state).canKill).toBe(false);
    }
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
