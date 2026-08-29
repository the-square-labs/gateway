import type { DockerComposeNormalizedModel } from '@/db/schema/index.js';

export interface ComposeValidationDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface ComposeValidationResult {
  valid: boolean;
  projectName: string | null;
  normalizedModel: DockerComposeNormalizedModel | null;
  configDigest: string | null;
  requiredVariables: string[];
  diagnostics: ComposeValidationDiagnostic[];
}

export interface ComposeGitBuildSpec {
  serviceName: string;
  dockerfilePath: string;
  contextPath: string;
  buildArgs: Record<string, string>;
}

export interface ComposeGitBuildPreparation {
  valid: boolean;
  runtimeYaml: string | null;
  services: ComposeGitBuildSpec[];
  validation: ComposeValidationResult;
  diagnostics: ComposeValidationDiagnostic[];
}
