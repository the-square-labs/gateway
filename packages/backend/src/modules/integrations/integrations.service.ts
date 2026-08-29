export {
  DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS,
  DEFAULT_GITLAB_CONNECTOR_SETTINGS,
  type DockerBuildCheckoutCredential,
  type DockerBuildSourceRepository,
  type DockerBuildSourceResolution,
  type GitHubOAuthSession,
  type GitUserCredentialStatus,
  type SafeIntegrationConnector,
} from './integrations.service.core.js';

import { IntegrationsGitLabSandboxService } from './integrations.service.gitlab-sandbox.js';

export class IntegrationsService extends IntegrationsGitLabSandboxService {}
