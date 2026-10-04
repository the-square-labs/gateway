export type ContainerLinkWorkloadType = "container" | "deployment" | "compose_service";

export type ContainerLinkStatus =
  | "creating"
  | "ready"
  | "waiting"
  | "pending"
  | "update_required"
  | "error"
  | "deleting";

export interface ContainerLinkEnvironment {
  host?: string;
  port?: string;
  url?: string;
}

/** One end of a link: a container name, a deployment id, or `<compose project id>:<url-encoded service>`. */
export interface ContainerLinkEndpoint {
  nodeId: string;
  type: ContainerLinkWorkloadType;
  resourceId: string;
}

export interface ContainerLink {
  id: string;
  source: ContainerLinkEndpoint;
  target: ContainerLinkEndpoint;
  targetPort: number;
  alias: string;
  environment: ContainerLinkEnvironment;
  networkName: string;
  status: ContainerLinkStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContainerLinkListParams {
  nodeId: string;
  type: ContainerLinkWorkloadType;
  resourceId: string;
  direction?: "outgoing" | "incoming";
}

export interface ContainerLinkCreateInput {
  sourceNodeId: string;
  sourceType: ContainerLinkWorkloadType;
  sourceResourceId: string;
  targetNodeId: string;
  targetType: ContainerLinkWorkloadType;
  targetResourceId: string;
  targetPort: number;
  alias?: string;
  environment?: ContainerLinkEnvironment;
}
