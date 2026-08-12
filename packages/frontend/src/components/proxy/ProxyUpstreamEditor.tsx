import { Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { api } from "@/services/api";
import type {
  CreateProxyHostRequest,
  DockerContainer,
  ForwardScheme,
  ProxyHost,
  ProxyUpstreamKind,
} from "@/types";

export interface ProxyUpstreamSelection {
  kind: ProxyUpstreamKind;
  scheme: ForwardScheme;
  manualHost: string;
  manualPort: number;
  dockerNodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
  containerPort: number | null;
}

interface ApplicationPort {
  containerPort: number;
}

export const DEFAULT_PROXY_UPSTREAM: ProxyUpstreamSelection = {
  kind: "manual",
  scheme: "http",
  manualHost: "",
  manualPort: 80,
  dockerNodeId: null,
  containerName: null,
  deploymentId: null,
  containerPort: null,
};

export function proxyUpstreamFromHost(host: ProxyHost): ProxyUpstreamSelection {
  return {
    kind: host.upstreamKind ?? "manual",
    scheme: host.forwardScheme ?? "http",
    manualHost: host.upstreamKind === "manual" ? host.forwardHost || "" : "",
    manualPort: host.upstreamKind === "manual" ? host.forwardPort || 80 : 80,
    dockerNodeId: host.dockerNodeId ?? null,
    containerName: host.dockerContainerName ?? null,
    deploymentId: host.dockerDeploymentId ?? null,
    containerPort: host.dockerContainerPort ?? null,
  };
}

export function proxyUpstreamRequest(
  selection: ProxyUpstreamSelection
): Partial<CreateProxyHostRequest> {
  if (selection.kind === "manual") {
    return {
      upstreamKind: "manual",
      forwardHost: selection.manualHost.trim(),
      forwardPort: selection.manualPort,
      forwardScheme: selection.scheme,
    };
  }
  if (selection.kind === "docker_container") {
    return {
      upstreamKind: "docker_container",
      forwardScheme: selection.scheme,
      dockerNodeId: selection.dockerNodeId,
      dockerContainerName: selection.containerName,
      dockerContainerPort: selection.containerPort,
      dockerProtocol: "tcp",
    };
  }
  return {
    upstreamKind: "docker_deployment",
    forwardScheme: selection.scheme,
    dockerDeploymentId: selection.deploymentId,
    dockerContainerPort: selection.containerPort,
    dockerProtocol: "tcp",
  };
}

export function isProxyUpstreamValid(selection: ProxyUpstreamSelection): boolean {
  if (selection.kind === "manual") {
    return selection.manualHost.trim().length > 0 && selection.manualPort > 0;
  }
  if (
    selection.kind === "docker_container" &&
    (!selection.dockerNodeId || !selection.containerName)
  ) {
    return false;
  }
  if (selection.kind === "docker_deployment" && !selection.deploymentId) return false;
  return !!selection.containerPort;
}

function applicationTcpPorts(container: DockerContainer): ApplicationPort[] {
  const seen = new Set<number>();
  return (container.ports ?? []).flatMap((port) => {
    if (port.type.toLowerCase() !== "tcp" || !port.privatePort || seen.has(port.privatePort))
      return [];
    seen.add(port.privatePort);
    return [{ containerPort: port.privatePort }];
  });
}

function targetKey(container: DockerContainer): string {
  if (container.kind === "deployment")
    return `deployment:${container.deploymentId ?? container.id}`;
  return `container:${container.nodeId ?? container._nodeId ?? ""}:${container.name}`;
}

function selectedTargetKey(selection: ProxyUpstreamSelection): string {
  if (selection.kind === "docker_deployment" && selection.deploymentId) {
    return `deployment:${selection.deploymentId}`;
  }
  if (selection.kind === "docker_container" && selection.dockerNodeId && selection.containerName) {
    return `container:${selection.dockerNodeId}:${selection.containerName}`;
  }
  return "__none__";
}

export function proxyUpstreamForDockerTarget(
  current: ProxyUpstreamSelection,
  target: DockerContainer
): ProxyUpstreamSelection {
  const ports = applicationTcpPorts(target);
  const onlyPort = ports.length === 1 ? ports[0]! : null;
  const nodeId = target.nodeId ?? target._nodeId ?? null;
  if (target.kind === "deployment") {
    return {
      ...current,
      kind: "docker_deployment",
      dockerNodeId: null,
      containerName: null,
      deploymentId: target.deploymentId ?? target.id,
      containerPort: onlyPort?.containerPort ?? null,
    };
  }
  return {
    ...current,
    kind: "docker_container",
    dockerNodeId: nodeId,
    containerName: target.name,
    deploymentId: null,
    containerPort: onlyPort?.containerPort ?? null,
  };
}

export function ProxyUpstreamFields({
  value,
  onChange,
  containers,
  disabled = false,
  allowManual = true,
}: {
  value: ProxyUpstreamSelection;
  onChange: (value: ProxyUpstreamSelection) => void;
  containers: DockerContainer[];
  disabled?: boolean;
  allowManual?: boolean;
}) {
  const selectedContainer = useMemo(
    () => containers.find((container) => targetKey(container) === selectedTargetKey(value)) ?? null,
    [containers, value]
  );
  const candidates = useMemo(() => {
    const result = [...containers];
    const hasReferencedContainer =
      value.kind === "docker_container" && !!value.dockerNodeId && !!value.containerName;
    if (!selectedContainer && hasReferencedContainer) {
      result.push({
        id: `${value.dockerNodeId}:${value.containerName}`,
        name: value.containerName!,
        image: "",
        state: "",
        status: "",
        created: 0,
        ports: value.containerPort
          ? [{ privatePort: value.containerPort, publicPort: 0, type: "tcp" }]
          : [],
        kind: "container",
        nodeId: value.dockerNodeId ?? undefined,
        availability: "unavailable",
      });
    }
    return result;
  }, [containers, selectedContainer, value]);
  const effectiveSelectedContainer = useMemo(
    () => candidates.find((container) => targetKey(container) === selectedTargetKey(value)) ?? null,
    [candidates, value]
  );
  const resourceCandidates = useMemo(
    () =>
      candidates.filter((candidate) =>
        value.kind === "docker_deployment"
          ? candidate.kind === "deployment"
          : candidate.kind !== "deployment"
      ),
    [candidates, value.kind]
  );
  const resourceOptions = useMemo<ComboboxOption[]>(
    () =>
      resourceCandidates.map((candidate) => {
        return {
          value: targetKey(candidate),
          label: candidate.name,
          keywords: [candidate._nodeName, candidate._nodeSlug].filter(Boolean).join(" "),
          disabled: candidate.availability === "unavailable",
        };
      }),
    [resourceCandidates]
  );
  const chooseTarget = (key: string) => {
    const target = candidates.find((candidate) => targetKey(candidate) === key);
    if (!target) return;
    onChange(proxyUpstreamForDockerTarget(value, target));
  };

  return (
    <>
      <SettingsControlRow title="Target" description="Choose how requests reach the upstream">
        <Select
          value={value.kind}
          onValueChange={(kind) =>
            onChange({
              ...DEFAULT_PROXY_UPSTREAM,
              scheme: value.scheme,
              kind: kind as ProxyUpstreamKind,
            })
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowManual ? <SelectItem value="manual">Manual address</SelectItem> : null}
            <SelectItem value="docker_container">Docker container</SelectItem>
            <SelectItem value="docker_deployment">Docker deployment</SelectItem>
          </SelectContent>
        </Select>
      </SettingsControlRow>

      {value.kind === "manual" ? (
        <>
          <SettingsControlRow
            title="Forward Host"
            description="Hostname or IP address of the upstream"
            controlsClassName="sm:w-full"
          >
            <Input
              value={value.manualHost}
              onChange={(event) => onChange({ ...value, manualHost: event.target.value })}
              placeholder="192.168.1.100"
              disabled={disabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Forward Port"
            description="Upstream service port"
            controlsClassName="sm:w-full"
          >
            <NumericInput
              value={value.manualPort}
              onChange={(manualPort) => onChange({ ...value, manualPort })}
              min={1}
              max={65535}
              disabled={disabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Scheme"
            description="Protocol used to reach the upstream"
            controlsClassName="sm:w-full"
          >
            <SchemeSelect value={value} onChange={onChange} disabled={disabled} />
          </SettingsControlRow>
        </>
      ) : (
        <>
          <SettingsControlRow
            title="Docker Resource"
            description="Container or deployment reached through Secure Link"
            controlsClassName="sm:w-full"
          >
            <Combobox
              value={selectedTargetKey(value)}
              options={resourceOptions}
              onValueChange={chooseTarget}
              contentClassName="right-0 left-auto max-h-64"
              placeholder="Select a resource..."
              searchPlaceholder={
                value.kind === "docker_deployment"
                  ? "Search deployments..."
                  : "Search containers..."
              }
              emptyMessage="No matching resources."
              disabled={disabled}
              renderOption={(option) => {
                const candidate = resourceCandidates.find(
                  (resource) => targetKey(resource) === option.value
                );
                if (!candidate) return option.label;
                const ports = applicationTcpPorts(candidate);
                const unavailable = candidate.availability === "unavailable";
                return (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{candidate.name}</span>
                    {(candidate._nodeName || candidate._nodeSlug) && (
                      <Badge
                        variant="secondary"
                        size="inline"
                        className={nodeBadgeClassName(candidate._nodeColor)}
                      >
                        {candidate._nodeName ?? candidate._nodeSlug}
                      </Badge>
                    )}
                    {unavailable && (
                      <Badge variant="secondary" size="inline">
                        Unavailable
                      </Badge>
                    )}
                    {!unavailable && ports.length === 0 && (
                      <Badge variant="secondary" size="inline">
                        No TCP ports
                      </Badge>
                    )}
                  </span>
                );
              }}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Application Port"
            description="Declared TCP port or a manually entered container port"
            controlsClassName="sm:w-full"
          >
            <Input
              type="number"
              min={1}
              max={65535}
              value={value.containerPort ?? ""}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                onChange({
                  ...value,
                  containerPort: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
                });
              }}
              placeholder="8080"
              disabled={disabled || !effectiveSelectedContainer}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Scheme"
            description="Protocol used to reach the upstream"
            controlsClassName="sm:w-full"
          >
            <SchemeSelect value={value} onChange={onChange} disabled={disabled} />
          </SettingsControlRow>
        </>
      )}
    </>
  );
}

function SchemeSelect({
  value,
  onChange,
  disabled,
}: {
  value: ProxyUpstreamSelection;
  onChange: (value: ProxyUpstreamSelection) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value.scheme}
      onValueChange={(scheme) => onChange({ ...value, scheme: scheme as ForwardScheme })}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="http">HTTP</SelectItem>
        <SelectItem value="https">HTTPS</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function ProxyUpstreamPanel({
  host,
  canManage,
  onUpdated,
}: {
  host: ProxyHost;
  canManage: boolean;
  onUpdated: (host: ProxyHost) => void;
}) {
  const [selection, setSelection] = useState(() => proxyUpstreamFromHost(host));
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [saving, setSaving] = useState(false);

  const loadContainers = useCallback(() => {
    void api
      .listDockerContainerSnapshots()
      .then(setContainers)
      .catch(() => setContainers([]));
  }, []);

  useEffect(() => setSelection(proxyUpstreamFromHost(host)), [host]);
  useEffect(loadContainers, [loadContainers]);
  useRealtime("docker.snapshot.changed", loadContainers);
  useRealtime("docker.deployment.changed", loadContainers);

  const changed = useMemo(
    () =>
      JSON.stringify(proxyUpstreamRequest(selection)) !==
      JSON.stringify(proxyUpstreamRequest(proxyUpstreamFromHost(host))),
    [host, selection]
  );

  const save = async () => {
    if (!canManage || !isProxyUpstreamValid(selection)) return;
    setSaving(true);
    try {
      const updated = await api.updateProxyHost(host.id, proxyUpstreamRequest(selection));
      onUpdated(updated);
      toast.success("Upstream updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update upstream");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell
      title="Upstream"
      description="Route traffic manually or to a Docker resource"
      className="overflow-visible"
      actions={
        canManage ? (
          <Button
            className="w-fit"
            onClick={save}
            disabled={!changed || !isProxyUpstreamValid(selection) || saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {saving ? "Saving..." : "Save"}
          </Button>
        ) : null
      }
      wrapHeader
    >
      <ProxyUpstreamFields
        value={selection}
        onChange={setSelection}
        containers={containers}
        disabled={!canManage}
      />
    </PanelShell>
  );
}
