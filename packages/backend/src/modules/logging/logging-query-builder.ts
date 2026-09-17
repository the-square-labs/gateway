import { AppError } from '@/middleware/error-handler.js';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateClickHouseIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new AppError(400, 'INVALID_CLICKHOUSE_IDENTIFIER', `Invalid ClickHouse identifier: ${identifier}`);
  }
  return identifier;
}

export function quoteClickHouseIdentifier(identifier: string): string {
  return `\`${validateClickHouseIdentifier(identifier)}\``;
}
