import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClientUuid } from "@/lib/client-id";
import { api } from "@/services/api";
import type { DockerComposeProject } from "@/types";
import { EnvironmentTab } from "../docker-detail/EnvironmentTab";
import { ManagedDatabaseLinksSection } from "../docker-detail/ManagedDatabaseLinksSection";

export function ComposeVariablesTab({
  project,
  canManage,
  onApplied,
}: {
  project: DockerComposeProject;
  canManage: boolean;
  onApplied: () => void | Promise<void>;
}) {
  const activeRevision = project.activeRevision;
  const serviceNames = useMemo(
    () => Object.keys(activeRevision?.normalizedModel.services ?? {}),
    [activeRevision]
  );
  const [selectedServiceName, setSelectedServiceName] = useState(serviceNames[0] ?? "");
  useEffect(() => {
    if (!serviceNames.includes(selectedServiceName)) setSelectedServiceName(serviceNames[0] ?? "");
  }, [selectedServiceName, serviceNames]);
  const selectedService = activeRevision?.normalizedModel.services[selectedServiceName];
  const targetResourceId = selectedServiceName
    ? `${project.id}:${encodeURIComponent(selectedServiceName)}`
    : project.id;
  const recreatesRunningProject = project.status === "running" || project.status === "degraded";
  const secretApi = useMemo(
    () => ({
      list: () => api.listDockerComposeSecrets(project.nodeId, project.id),
      create: (key: string, value: string) =>
        api.createDockerComposeSecret(project.nodeId, project.id, key, value),
      update: (id: string, value: string) =>
        api.updateDockerComposeSecret(project.nodeId, project.id, id, value),
      delete: (id: string) => api.deleteDockerComposeSecret(project.nodeId, project.id, id),
    }),
    [project.id, project.nodeId]
  );

  const saveVariables = async (variables: Record<string, string>) => {
    if (!activeRevision) throw new Error("No active Compose revision");
    const secrets = await secretApi.list();
    const revision = await api.createDockerComposeRevision(project.nodeId, project.id, {
      yaml: activeRevision.sourceYaml,
      variables,
      secretKeys: secrets.map((secret) => secret.key),
    });
    if (recreatesRunningProject) {
      await api.startDockerComposeOperation(project.nodeId, project.id, "apply", {
        revisionId: revision.id,
        idempotencyKey: createClientUuid(),
      });
      toast.success("Variables saved in a new revision and apply started");
    } else {
      toast.success("Variables saved as a new inactive revision");
    }
    await onApplied();
  };

  return (
    <div className="space-y-4 pb-6">
      <ManagedDatabaseLinksSection
        key={targetResourceId}
        nodeId={project.nodeId}
        targetType="compose_service"
        targetResourceId={targetResourceId}
        containerName={`${project.name} / ${selectedServiceName}`}
        disabled={!selectedServiceName || !canManage}
        existingVariableNames={Object.keys(selectedService?.environment ?? {})}
        targetSelector={
          <SettingsControlRow
            title="Compose service"
            description="Database variables and the private connector network are attached to this service"
          >
            <Select value={selectedServiceName} onValueChange={setSelectedServiceName}>
              <SelectTrigger aria-label="Compose service">
                <SelectValue placeholder="Select service" />
              </SelectTrigger>
              <SelectContent>
                {serviceNames.map((serviceName) => (
                  <SelectItem key={serviceName} value={serviceName}>
                    {serviceName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
        }
      />

      {activeRevision ? (
        <EnvironmentTab
          nodeId={project.nodeId}
          containerId={project.id}
          containerName={project.name}
          serviceEnv={activeRevision.variables ?? {}}
          onSaveServiceEnv={saveVariables}
          canEditOverride={canManage}
          canManageSecretsOverride={canManage}
          secretApi={secretApi}
          environmentDescription="Saved as immutable Compose revision variables"
          secretsDescription="Encrypted at rest — supplied to Compose interpolation during apply"
          serviceSaveLabel={recreatesRunningProject ? "Save & Recreate" : "Save"}
          serviceSaveDescription={
            recreatesRunningProject
              ? "Saving variables creates and applies a new immutable revision. Running services will be recreated and experience brief downtime. Continue?"
              : "Saving variables creates a new immutable revision for this stopped project."
          }
        />
      ) : (
        <PanelShell
          title="Variables"
          description="Adopt the project before managing variables and secrets."
          bodyClassName="p-6 text-sm text-muted-foreground"
        >
          External projects do not have a Gateway-owned revision yet.
        </PanelShell>
      )}
    </div>
  );
}
