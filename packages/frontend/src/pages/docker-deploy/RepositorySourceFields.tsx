import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { DockerBuildSourceRepository } from "@/types";

interface RepositorySourceFieldsProps {
  connectorId: string;
  connectorOptions: ComboboxOption[];
  repositories: DockerBuildSourceRepository[];
  repositoryOptions: ComboboxOption[];
  projectId: string;
  branch: string;
  dockerfilePath: string;
  contextPath: string;
  autoBuild: boolean;
  autoDeploy: boolean;
  onConnectorChange: (value: string) => void;
  onProjectChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onDockerfilePathChange: (value: string) => void;
  onContextPathChange: (value: string) => void;
  onAutoBuildChange: (value: boolean) => void;
  onAutoDeployChange: (value: boolean) => void;
}

export function RepositorySourceFields({
  connectorId,
  connectorOptions,
  repositories,
  repositoryOptions,
  projectId,
  branch,
  dockerfilePath,
  contextPath,
  autoBuild,
  autoDeploy,
  onConnectorChange,
  onProjectChange,
  onBranchChange,
  onDockerfilePathChange,
  onContextPathChange,
  onAutoBuildChange,
  onAutoDeployChange,
}: RepositorySourceFieldsProps) {
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
          emptyMessage="No enabled Git integrations."
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
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
            emptyMessage="No allowlisted repositories."
            disabled={!connectorId}
          />
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Dockerfile</label>
          <Input
            value={dockerfilePath}
            onChange={(event) => onDockerfilePathChange(event.target.value)}
            placeholder="Dockerfile"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Build context</label>
          <Input
            value={contextPath}
            onChange={(event) => onContextPathChange(event.target.value)}
            placeholder="."
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Automatic builds</p>
          <p className="text-xs text-muted-foreground">
            Build new commits detected by webhook or polling.
          </p>
        </div>
        <Switch checked={autoBuild} onChange={onAutoBuildChange} ariaLabel="Automatic builds" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Automatic deployment</p>
          <p className="text-xs text-muted-foreground">
            Deploy accepted artifacts after successful builds.
          </p>
        </div>
        <Switch
          checked={autoDeploy}
          onChange={onAutoDeployChange}
          ariaLabel="Automatic deployment"
        />
      </div>
    </div>
  );
}
