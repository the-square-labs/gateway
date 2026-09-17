import { ExportService } from './export.service.js';
import { TemplatesService } from './templates.service.js';

const constructors = { TemplatesService, ExportService };
export type PkiConstructors = typeof constructors;

import { eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import { certificateTemplates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import { CryptoService } from '@/services/crypto.service.js';

const loggerTemplatesService = createChildLogger('TemplatesService');
export const pkiCommercialRuntime = {
  constructors,
  eq,
  inject,
  injectable,
  TOKENS,
  certificateTemplates,
  createChildLogger,
  AppError,
  x509,
  CryptoService,
  loggerTemplatesService,
};
