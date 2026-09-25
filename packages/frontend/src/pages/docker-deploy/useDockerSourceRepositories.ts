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
    // One picker list authorized by the workload's create/edit scope, so a missing integration scope for one
    // provider can no longer blank the whole list.
    void api
      .listDockerSourceConnectors()
      .then((connectors) => {
        if (cancelled) return;
        setConnectorOptions(
          connectors.map((connector) => ({
            value: connector.id,
            label: connector.name,
            keywords: connector.provider,
          }))
        );
      })
      .catch(() => !cancelled && setConnectorOptions([]));
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
