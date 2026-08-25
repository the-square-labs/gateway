import { useEffect, useState } from "react";
import type { ComboboxOption } from "@/components/common/Combobox";
import { api } from "@/services/api";
import type { DockerBuildSourceRepository, DockerSourceTarget } from "@/types";

export function useDockerSourceRepositories(
  open: boolean,
  connectorId: string,
  target?: DockerSourceTarget
) {
  const [connectorOptions, setConnectorOptions] = useState<ComboboxOption[]>([]);
  const [repositories, setRepositories] = useState<DockerBuildSourceRepository[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([
      api.listGitLabConnectors({ enabled: true }),
      api.listGitConnectors("github"),
      api.listGitConnectors("git"),
    ])
      .then(([gitlab, github, git]) => {
        if (cancelled) return;
        setConnectorOptions([
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
      .catch(() => setConnectorOptions([]));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !connectorId) {
      setRepositories([]);
      return;
    }
    let cancelled = false;
    void api
      .listDockerBuildRepositories(connectorId, target)
      .then((items) => {
        if (!cancelled) setRepositories(items.filter((repository) => !repository.archived));
      })
      .catch(() => !cancelled && setRepositories([]));
    return () => {
      cancelled = true;
    };
  }, [connectorId, open, target]);

  return { connectorOptions, repositories };
}
