import { useCallback, useMemo, useState } from "react";

function deriveCurrentNanoCPUs(hostConfig: Record<string, any>): number {
  const nanoCPUs = Number(hostConfig.NanoCPUs ?? 0);
  if (Number.isFinite(nanoCPUs) && nanoCPUs > 0) return nanoCPUs;

  const cpuQuota = Number(hostConfig.CPUQuota ?? 0);
  const cpuPeriod = Number(hostConfig.CPUPeriod ?? 0);
  if (Number.isFinite(cpuQuota) && Number.isFinite(cpuPeriod) && cpuQuota > 0 && cpuPeriod > 0) {
    return Math.round((cpuQuota / cpuPeriod) * 1e9);
  }

  return 0;
}

export function buildContainerMutationSnapshot(
  container: Record<string, any> | null | undefined
): string {
  if (!container) return "";

  const config = (container.Config ?? {}) as Record<string, any>;
  const hostConfig = (container.HostConfig ?? {}) as Record<string, any>;
  const state = (container.State ?? {}) as Record<string, any>;

  return JSON.stringify({
    id: container.Id ?? "",
    image: config.Image ?? "",
    env: config.Env ?? [],
    ports: hostConfig.PortBindings ?? {},
    mounts: container.Mounts ?? [],
    networks: container.NetworkSettings?.Networks ?? {},
    entrypoint: config.Entrypoint ?? [],
    cmd: config.Cmd ?? [],
    workingDir: config.WorkingDir ?? "",
    user: config.User ?? "",
    hostname: config.Hostname ?? "",
    labels: config.Labels ?? {},
    restartPolicy: hostConfig.RestartPolicy ?? {},
    memory: hostConfig.Memory ?? 0,
    memorySwap: hostConfig.MemorySwap ?? 0,
    nanoCPUs: deriveCurrentNanoCPUs(hostConfig),
    cpuShares: hostConfig.CpuShares ?? 0,
    pidsLimit: hostConfig.PidsLimit ?? 0,
    transition: (container as any)?._transition ?? null,
    state: state.Status ?? "",
  });
}

export function shouldSettleMutationTransition(
  previousSignature: string,
  next: Record<string, any> | null | undefined
) {
  return !(next as any)?._transition && buildContainerMutationSnapshot(next) !== previousSignature;
}

export function useContainerMutationTransition(backendTransition?: string) {
  const [localMutationTransition, setLocalMutationTransition] = useState<
    "updating" | "recreating" | null
  >(null);

  const effectiveTransition = useMemo(
    () => backendTransition ?? localMutationTransition ?? undefined,
    [backendTransition, localMutationTransition]
  );

  const beginMutationTransition = useCallback((transition: "updating" | "recreating") => {
    setLocalMutationTransition(transition);
  }, []);

  const clearMutationTransition = useCallback(() => {
    setLocalMutationTransition(null);
  }, []);

  return {
    effectiveTransition,
    beginMutationTransition,
    clearMutationTransition,
  };
}
