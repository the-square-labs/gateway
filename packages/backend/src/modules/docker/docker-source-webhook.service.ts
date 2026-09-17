import type { SupportedSourceProvider } from './docker-source-mappers.js';
export interface DockerSourceWebhookResult {
  accepted: boolean;
  duplicate: boolean;
  sourceBindingId: string;
  provider: SupportedSourceProvider;
  deliveryId: string;
  commitSha: string;
  branch: string;
  autoBuild: boolean;
  autoDeploy: boolean;
}
