import { useMemo } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
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
        nodeId={project.nodeId}
        targetType="compose_service"
        targetResourceId={project.id}
        containerName={project.name}
        disabled={serviceNames.length === 0 || !canManage}
        composeServices={serviceNames.map((name) => ({
          name,
          existingVariableNames: Object.keys(
            activeRevision?.normalizedModel.services[name]?.environment ?? {}
          ),
        }))}
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
