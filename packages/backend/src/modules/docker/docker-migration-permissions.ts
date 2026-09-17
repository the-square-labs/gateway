export interface DockerMigrationPermissionPlan {
  sourceNodeId: string;
  sourceResourceId: string;
  targetNodeId: string;
  targetFolderId: string | null;
  keepSource: boolean;
  hasVolumes: boolean;
  createsNetworks: boolean;
  hasProxyHosts: boolean;
  volumes?: Array<{
    resourceId: string;
    folderId: string | null;
  }>;
  networks?: Array<{
    resourceId: string;
    resourceKey: string;
    folderId: string | null;
    targetResourceId: string | null;
  }>;
  proxyHostIds?: string[];
}
