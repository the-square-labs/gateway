import { and, asc, eq, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm';
import {
  databaseConnections,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  nodes,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { isGatewayInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';

const loggerManagedDatabaseService = createChildLogger('ManagedDatabaseService');
const loggerManagedDatabaseBindings = createChildLogger('ManagedDatabaseBindings');
const loggerManagedDatabaseBindingIdentityRuntime = createChildLogger('ManagedDatabaseBindingIdentityRuntime');

export type { managedDatabaseInstances } from '@/db/schema/index.js';
export type { LicensePolicyService } from '@/modules/license/license-policy.service.js';

import { ManagedDatabaseBindingService } from './managed-database-bindings.service.js';
import { ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';
import { ManagedDatabaseService } from './managed-databases.service.js';
export const managedDatabaseConstructors = {
  ManagedDatabaseService,
  ManagedDatabaseBindingService,
  ManagedDatabaseTunnelProxy,
};
export type ManagedDatabaseConstructors = typeof managedDatabaseConstructors;
export const managedDatabaseRuntime = {
  constructors: managedDatabaseConstructors,
  createChildLogger,
  loggerManagedDatabaseService,
  and,
  eq,
  isNotNull,
  isNull,
  databaseConnections,
  managedDatabaseBindings,
  managedDatabaseInstances,
  grantCreatedResourcePermissions,
  writeWithAllocatedSlug,
  requireConfiguredLicensePolicy,
  asc,
  nodes,
  sql,
  inArray,
  like,
  managedDatabaseBindingPlacements,
  managedStorageBindings,
  hasScope,
  loggerManagedDatabaseBindings,
  isGatewayInternalContainer,
  loggerManagedDatabaseBindingIdentityRuntime,
};
