import { SiemDeliveryService } from './siem-delivery.service.js';
import { SiemDestinationService } from './siem-destination.service.js';
import { SiemAuditOutboxService } from './siem-outbox.service.js';
import { SiemTransportService } from './siem-transport.service.js';

const constructors = { SiemAuditOutboxService, SiemTransportService, SiemDestinationService, SiemDeliveryService };
export type SiemConstructors = typeof constructors;

import { and, count, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { siemDeliveries, siemDestinations } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { SiemCustomHeaderNameSchema, SiemEndpointUrlSchema } from '@/modules/audit/siem.schemas.js';
import {
  hasConfiguredLicenseFeatureForExistingRuntime,
  requireConfiguredLicensePolicy,
} from '@/modules/license/license-policy.service.js';
import { checkOutboundWebhookTarget } from '@/modules/settings/outbound-webhook-policy.service.js';
import { fetchWithPinnedAddresses } from '@/modules/settings/outbound-webhook-request.js';

const loggerSiemDestinationService = createChildLogger('SiemDestinationService');
const loggerSiemDeliveryService = createChildLogger('SiemDeliveryService');
export const siemCommercialRuntime = {
  constructors,
  and,
  eq,
  isNull,
  siemDeliveries,
  siemDestinations,
  hasConfiguredLicenseFeatureForExistingRuntime,
  AppError,
  checkOutboundWebhookTarget,
  fetchWithPinnedAddresses,
  SiemCustomHeaderNameSchema,
  SiemEndpointUrlSchema,
  count,
  desc,
  ilike,
  inArray,
  createChildLogger,
  buildWhere,
  requireConfiguredLicensePolicy,
  gte,
  lt,
  lte,
  or,
  sql,
  loggerSiemDestinationService,
  loggerSiemDeliveryService,
};
