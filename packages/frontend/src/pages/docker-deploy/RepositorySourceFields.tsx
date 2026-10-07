import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Input } from "@/components/ui/input";
import type { DockerBuildSourceRepository } from "@/types";
import type { SourcePickerErrors } from "./useDockerSourceRepositories";

interface RepositorySourceFieldsProps {
  /** The Git integration options are still loading; the enclosing dialog waits for them. */
  loading?: boolean;
  /** Why the integration or repository list could not be loaded (a missing permission, say). */
  loadErrors?: SourcePickerErrors;
  connectorId: string;
  connectorOptions: ComboboxOption[];
  repositories: DockerBuildSourceRepository[];
  repositoryOptions: ComboboxOption[];
  projectId: string;
  branch: string;
  dockerfilePath: string;
  contextPath: string;
  composeFilePath?: string;
  pages?: boolean;
  autoBuild: boolean;
  autoDeploy: boolean;
  onConnectorChange: (value: string) => void;
  onProjectChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onDockerfilePathChange: (value: string) => void;
  onContextPathChange: (value: string) => void;
  onComposeFilePathChange?: (value: string) => void;
  onAutoBuildChange: (value: boolean) => void;
  onAutoDeployChange: (value: boolean) => void;
}

export function RepositorySourceFields({
  loading = false,
  loadErrors,
  connectorId,
  connectorOptions,
  repositories,
  repositoryOptions,
  projectId,
  branch,
  dockerfilePath,
  contextPath,
  composeFilePath,
  pages = false,
  autoBuild,
  autoDeploy,
  onConnectorChange,
  onProjectChange,
  onBranchChange,
  onDockerfilePathChange,
  onContextPathChange,
  onComposeFilePathChange,
  onAutoBuildChange,
  onAutoDeployChange,
}: RepositorySourceFieldsProps) {
  useContentLoading(loading);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Git integration <span className="text-destructive">*</span>
        </label>
        <Combobox
          value={connectorId}
          options={connectorOptions}
          onValueChange={onConnectorChange}
          placeholder="Select Git integration"
          searchPlaceholder="Search integrations..."
          emptyMessage={
            loadErrors?.connectors ??
            "No enabled Git integrations you may connect (needs integrations:<provider>:use)."
          }
        />
        {loadErrors?.connectors && (
          <p className="text-xs text-destructive" role="alert">
            {loadErrors.connectors}
          </p>
        )}
      </div>
      <div
        className={
          pages ? "space-y-4" : "grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]"
        }
      >
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Repository <span className="text-destructive">*</span>
          </label>
          <Combobox
            value={projectId}
            options={repositoryOptions}
            onValueChange={(value) => {
              onProjectChange(value);
              const repository = repositories.find((candidate) => candidate.projectId === value);
              if (repository?.defaultBranch) onBranchChange(repository.defaultBranch);
            }}
            placeholder={connectorId ? "Select allowlisted repository" : "Select integration first"}
            searchPlaceholder="Search repositories..."
            emptyMessage={
              loadErrors?.repositories ??
              "No allowlisted repositories you may connect (needs integrations:<provider>:use on them)."
            }
            disabled={!connectorId}
          />
          {loadErrors?.repositories && (
            <p className="text-xs text-destructive" role="alert">
              {loadErrors.repositories}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Branch <span className="text-destructive">*</span>
          </label>
          <Input
            value={branch}
            onChange={(event) => onBranchChange(event.target.value)}
            placeholder="main"
          />
        </div>
      </div>
      {!pages && (
        <div
          className={
            onComposeFilePathChange ? "space-y-1.5" : "grid grid-cols-1 gap-3 sm:grid-cols-2"
          }
        >
          {onComposeFilePathChange ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Compose file</label>
              <Input
                value={composeFilePath ?? ""}
                onChange={(event) => onComposeFilePathChange(event.target.value)}
                placeholder="compose.yaml"
              />
              <p className="text-xs text-muted-foreground">
                Repository-relative Compose file. Each service with a build section is built
                independently.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Dockerfile</label>
              <Input
                value={dockerfilePath}
                onChange={(event) => onDockerfilePathChange(event.target.value)}
                placeholder="Dockerfile"
              />
            </div>
          )}
          {!onComposeFilePathChange && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Build context</label>
              <Input
                value={contextPath}
                onChange={(event) => onContextPathChange(event.target.value)}
                placeholder="."
              />
            </div>
          )}
        </div>
      )}
      <SwitchCard
        label="Automatic builds"
        description="Build new commits detected by webhook or polling."
        checked={autoBuild}
        onCheckedChange={onAutoBuildChange}
      />
      {!pages && (
        <SwitchCard
          label="Automatic deployment"
          description="Deploy accepted artifacts after successful builds."
          checked={autoDeploy}
          onCheckedChange={onAutoDeployChange}
        />
      )}
    </div>
  );
}
