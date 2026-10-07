import { useEffect, useState } from "react";
import type { ComboboxOption } from "@/components/common/Combobox";
import { gitScopeTruncationHint } from "@/components/common/git-scope-targets";
import { pickerLoadError } from "@/lib/picker-load-error";
import { api } from "@/services/api";
import type { DockerBuildSourceRepository, DockerSourceTarget } from "@/types";
import type { GitScopeTargetTruncation } from "@/types/integrations";

const SEARCH_DEBOUNCE_MS = 300;

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
  const [listTruncation, setListTruncation] = useState<GitScopeTargetTruncation>();
  const [search, setSearch] = useState("");
  const [searchTruncation, setSearchTruncation] = useState<GitScopeTargetTruncation>();

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
    setListTruncation(undefined);
    setSearch("");
    if (!open || !connectorId) {
      setRepositories([]);
      setRepositoriesError(null);
      return;
    }
    let cancelled = false;
    void api
      .listDockerBuildRepositories(connectorId, target)
      .then(({ repositories: items, truncated }) => {
        if (cancelled) return;
        setRepositoriesError(null);
        setListTruncation(truncated);
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

  // A cut list (a GitHub account past the listing bound) is searched on the server as the user
  // types; found repositories join the list, so a picked one stays selectable.
  const query = search.trim();
  useEffect(() => {
    if (!open || !connectorId || !listTruncation || !query) {
      setSearchTruncation(undefined);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .listDockerBuildRepositories(connectorId, target, query)
        .then(({ repositories: found, truncated }) => {
          if (cancelled) return;
          setSearchTruncation(truncated);
          setRepositories((current) => {
            const known = new Set(current.map((repository) => repository.projectId));
            const added = found.filter(
              (repository) => !repository.archived && !known.has(repository.projectId)
            );
            return added.length > 0 ? [...current, ...added] : current;
          });
        })
        .catch(() => {
          // The list stays as it was; the hint keeps asking for a narrower search.
          if (!cancelled) setSearchTruncation({ more: 0, exact: false });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connectorId, listTruncation, open, query, target]);

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
    /** "More may exist, refine the search." while the list or the current search is cut. */
    repositoriesHint: gitScopeTruncationHint(query ? searchTruncation : listTruncation),
    onRepositorySearch: setSearch,
  };
}
