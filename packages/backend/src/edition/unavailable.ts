import { AppError } from '@/middleware/error-handler.js';

export function commercialModuleUnavailable(): never {
  throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'This operation requires an available commercial module');
}
