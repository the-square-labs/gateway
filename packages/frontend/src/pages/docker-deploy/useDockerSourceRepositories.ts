import { useEffect, useState } from "react";
import type { ComboboxOption } from "@/components/common/Combobox";
import { pickerLoadError } from "@/lib/picker-load-error";
import { api } from "@/services/api";
import type { DockerBuildSourceRepository, DockerSourceTarget } from "@/types";

/** Why the integration or repository picker is empty, when its list could not be loaded. */
export interface SourcePickerErrors {
  connectors: string | null;
  repositories: string | null;
}

export function useDockerSourceRepositories(
  open: boolean,
  connectorId: string,
  target?: DockerSourceTarget
) {
  const [connectorOptions, setConnectorOptions] = useState<ComboboxOption[]>([]);
  const [connectorsLoaded, setConnectorsLoaded] = useState(false);
  const [repositories, setRepositories] = useState<DockerBuildSourceRepository[]>([]);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConnectorsLoaded(false);
      return;
    }
    let cancelled = false;
    // One picker list authorized by the workload's create/edit scope, so a missing integration scope for one
    // provider can no longer blank the whole list.
    void api
      .listDockerSourceConnectors()
      .then((connectors) => {
        if (cancelled) return;
        setConnectorsError(null);
        setConnectorOptions(
          connectors.map((connector) => ({
            value: connector.id,
            label: connector.name,
            keywords: connector.provider,
          }))
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setConnectorOptions([]);
        setConnectorsError(pickerLoadError(error, "Git integrations"));
      })
      .finally(() => {
        if (!cancelled) setConnectorsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !connectorId) {
      setRepositories([]);
      setRepositoriesError(null);
      return;
    }
    let cancelled = false;
    void api
      .listDockerBuildRepositories(connectorId, target)
      .then((items) => {
        if (cancelled) return;
        setRepositoriesError(null);
        setRepositories(items.filter((repository) => !repository.archived));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRepositories([]);
        setRepositoriesError(pickerLoadError(error, "repositories"));
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId, open, target]);

  const loadErrors: SourcePickerErrors = {
    connectors: connectorsError,
    repositories: repositoriesError,
  };
  // The integration picker a repository form opens with; repositories follow the user's choice.
  return {
    connectorOptions,
    connectorsLoading: open && !connectorsLoaded,
    repositories,
    loadErrors,
  };
}
