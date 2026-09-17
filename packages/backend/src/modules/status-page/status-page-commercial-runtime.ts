import { StatusPageService } from './status-page.service.js';

const constructors = { StatusPageService };
export type StatusPageConstructors = typeof constructors;

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  databaseConnections,
  dockerComposeProjects,
  dockerDeployments,
  dockerHealthChecks,
  nginxTemplates,
  nodes,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyHosts,
  settings,
  sslCertificates,
  statusPageIncidents,
  statusPageIncidentUpdates,
  statusPageServices,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';

const loggerStatusPageService = createChildLogger('StatusPageService');
const loggerStatusIncidentEvaluator = createChildLogger('StatusIncidentEvaluator');
export const statusPageCommercialRuntime = {
  constructors,
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  databaseConnections,
  dockerComposeProjects,
  dockerDeployments,
  dockerHealthChecks,
  nginxTemplates,
  nodes,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyHosts,
  settings,
  sslCertificates,
  statusPageIncidents,
  statusPageIncidentUpdates,
  statusPageServices,
  createChildLogger,
  AppError,
  requireConfiguredLicensePolicy,
  loggerStatusPageService,
  loggerStatusIncidentEvaluator,
};
