import { useEffect, useState } from "react";
import type { ComboboxOption } from "@/components/common/Combobox";
import { api } from "@/services/api";
import type {
  DockerBuildAdmissionStatus,
  DockerBuildSourceRepository,
  DockerRegistry,
  Node,
} from "@/types";
import type { DockerDeploySourceMode } from "./types";

interface UseDockerDeployDataOptions {
  allNodes: Node[];
  deployNodeId: string;
  hasScope: (scope: string) => boolean;
  open: boolean;
  sourceConnectorId: string;
  sourceMode: DockerDeploySourceMode;
}

function extractTags(data: unknown): string[] {
  const tags: string[] = [];
  for (const img of Array.isArray(data) ? data : []) {
    for (const tag of (img as any).repoTags ?? (img as any).RepoTags ?? []) {
      if (tag && tag !== "<none>:<none>") tags.push(tag);
    }
  }
  return tags;
}

export function useDockerDeployData({
  allNodes,
  deployNodeId,
  hasScope,
  open,
  sourceConnectorId,
  sourceMode,
}: UseDockerDeployDataOptions) {
  const [registries, setRegistries] = useState<DockerRegistry[]>([]);
  const [deployLocalImages, setDeployLocalImages] = useState<string[]>([]);
  const [deployPullableImages, setDeployPullableImages] = useState<string[]>([]);
  const [sourceConnectorOptions, setSourceConnectorOptions] = useState<ComboboxOption[]>([]);
  const [sourceRepositories, setSourceRepositories] = useState<DockerBuildSourceRepository[]>([]);
  const [sourceAdmission, setSourceAdmission] = useState<DockerBuildAdmissionStatus | null>(null);
  const [checkingSourceAdmission, setCheckingSourceAdmission] = useState(false);

  useEffect(() => {
    if (!open || !hasScope("docker:registries:view")) {
      setRegistries([]);
      return;
    }
    api
      .listDockerRegistries()
      .then(setRegistries)
      .catch(() => setRegistries([]));
  }, [hasScope, open]);

  useEffect(() => {
    if (!open || sourceMode !== "repository") return;
    let cancelled = false;
    void Promise.all([
      api.listGitLabConnectors({ enabled: true }),
      api.listGitConnectors("github"),
      api.listGitConnectors("git"),
    ])
      .then(([gitlab, github, git]) => {
        if (cancelled) return;
        setSourceConnectorOptions([
          ...gitlab.map((connector) => ({
            value: connector.id,
            label: connector.name,
            keywords: `gitlab ${connector.baseUrl}`,
          })),
          ...github
            .filter((connector) => connector.enabled)
            .map((connector) => ({
              value: connector.id,
              label: connector.name,
              keywords: `github ${connector.baseUrl}`,
            })),
          ...git
            .filter((connector) => connector.enabled)
            .map((connector) => ({
              value: connector.id,
              label: connector.name,
              keywords: `git ${connector.baseUrl}`,
            })),
        ]);
      })
      .catch(() => setSourceConnectorOptions([]));
    return () => {
      cancelled = true;
    };
  }, [open, sourceMode]);

  useEffect(() => {
    if (!open || sourceMode !== "repository" || !sourceConnectorId) {
      setSourceRepositories([]);
      return;
    }
    let cancelled = false;
    void api
      .listDockerBuildRepositories(sourceConnectorId)
      .then(
        (repositories) =>
          !cancelled &&
          setSourceRepositories(repositories.filter((repository) => !repository.archived))
      )
      .catch(() => !cancelled && setSourceRepositories([]));
    return () => {
      cancelled = true;
    };
  }, [open, sourceConnectorId, sourceMode]);

  useEffect(() => {
    if (!open || sourceMode !== "repository" || !deployNodeId) {
      setSourceAdmission(null);
      setCheckingSourceAdmission(false);
      return;
    }
    let cancelled = false;
    setCheckingSourceAdmission(true);
    void api
      .getDockerBuildAdmission(deployNodeId)
      .then((status) => {
        if (!cancelled) setSourceAdmission(status);
      })
      .catch((error) => {
        if (!cancelled) {
          setSourceAdmission({
            ready: false,
            code: "BUILD_ADMISSION_CHECK_FAILED",
            message:
              error instanceof Error ? error.message : "Build capacity could not be verified",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingSourceAdmission(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deployNodeId, open, sourceMode]);

  useEffect(() => {
    if (!deployNodeId) {
      setDeployLocalImages([]);
      setDeployPullableImages([]);
      return;
    }
    api
      .listDockerImages(deployNodeId)
      .then((data) => setDeployLocalImages(extractTags(data).sort()))
      .catch(() => setDeployLocalImages([]));

    if (!hasScope("docker:images:pull") && !hasScope(`docker:images:pull:${deployNodeId}`)) {
      setDeployPullableImages([]);
      return;
    }
    const otherNodes = allNodes.filter((node) => node.id !== deployNodeId);
    if (otherNodes.length === 0) {
      setDeployPullableImages([]);
      return;
    }
    Promise.all(
      otherNodes.map((node) =>
        api
          .listDockerImages(node.id)
          .then(extractTags)
          .catch(() => [] as string[])
      )
    ).then((results) => {
      const localSet = new Set<string>();
      api
        .listDockerImages(deployNodeId)
        .then((data) => {
          for (const tag of extractTags(data)) localSet.add(tag);
          const pullable = new Set<string>();
          for (const tags of results) {
            for (const tag of tags) {
              if (!localSet.has(tag)) pullable.add(tag);
            }
          }
          setDeployPullableImages(Array.from(pullable).sort());
        })
        .catch(() => {});
    });
  }, [allNodes, deployNodeId, hasScope]);

  return {
    checkingSourceAdmission,
    deployLocalImages,
    deployPullableImages,
    registries,
    sourceAdmission,
    sourceConnectorOptions,
    sourceRepositories,
  };
}
