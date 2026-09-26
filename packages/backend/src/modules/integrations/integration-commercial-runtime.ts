import { and, desc, eq, isNull } from 'drizzle-orm';

export type { SQL } from 'drizzle-orm';

import {
  integrationConnectorCredentials,
  integrationConnectorProjects,
  integrationConnectors,
} from '@/db/schema/index.js';
import {
  gitConnectorGrant,
  gitGrantCovers,
  gitGrantNeedsLookup,
  gitGrantsConnectorWide,
  gitGrantsCover,
  hasGitGrant,
  hasGitGrants,
  hasGitRepositoryScope,
  principalGitConnectorGrants,
  principalGitGrantNeedsLookup,
  principalHasGitRepositoryScope,
} from '@/lib/git-scopes.js';
import { hasScope } from '@/lib/permissions.js';
import { TtlCache } from '@/lib/ttl-cache.js';
import { buildWhere } from '@/lib/utils.js';
import {
  hasConfiguredLicenseFeatureForExistingRuntime,
  requireConfiguredLicensePolicy,
} from '@/modules/license/license-policy.service.js';
import {
  isUnderGitLabPath,
  matchesScopeTargetSearch,
  parseScopeTargetIds,
  SCOPE_TARGET_LOOKUP_TTL_MS,
  SCOPE_TARGET_SEARCH_TTL_MS,
  unresolvedScopeTarget,
} from './git-scope-targets.js';
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
  // Git scope qualifiers (connector, GitLab group/project) and the scope picker.
  gitConnectorGrant,
  gitGrantCovers,
  gitGrantNeedsLookup,
  hasGitGrant,
  hasGitRepositoryScope,
  principalGitConnectorGrants,
  principalGitGrantNeedsLookup,
  principalHasGitRepositoryScope,
  gitGrantsConnectorWide,
  gitGrantsCover,
  hasGitGrants,
  TtlCache,
  isUnderGitLabPath,
  matchesScopeTargetSearch,
  parseScopeTargetIds,
  unresolvedScopeTarget,
  SCOPE_TARGET_LOOKUP_TTL_MS,
  SCOPE_TARGET_SEARCH_TTL_MS,
};
