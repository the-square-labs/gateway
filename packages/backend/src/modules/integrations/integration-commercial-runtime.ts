import { and, desc, eq, isNull } from 'drizzle-orm';

export type { SQL } from 'drizzle-orm';

import {
  integrationConnectorCredentials,
  integrationConnectorProjects,
  integrationConnectors,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { buildWhere } from '@/lib/utils.js';
import {
  hasConfiguredLicenseFeatureForExistingRuntime,
  requireConfiguredLicensePolicy,
} from '@/modules/license/license-policy.service.js';
import {
  buildGitLabFileCommitAuditDetails,
  GITLAB_AUDIT_ACTIONS,
  hashGitLabDiff,
  redactGitLabAuditDetails,
} from './integration-audit.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';

// Pass the existing host schema/operators/security helpers into the one private
// module; it must not bundle a second copy of shared runtime state.
export const integrationCommercialRuntime = {
  desc,
  buildWhere,
  and,
  eq,
  integrationConnectorProjects,
  integrationConnectors,
  hasScope,
  GITLAB_AUDIT_ACTIONS,
  redactGitLabAuditDetails,
  assertConnectorOperationAccess,
  hasConfiguredLicenseFeatureForExistingRuntime,
  isNull,
  buildGitLabFileCommitAuditDetails,
  hashGitLabDiff,
  integrationConnectorCredentials,
  requireConfiguredLicensePolicy,
};
