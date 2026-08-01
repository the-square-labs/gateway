import { AppError } from '@/middleware/error-handler.js';

export function quoteClickHouseIdentifier(identifier: string): string {
  if (!identifier || identifier.length > 255 || /[\0\r\n]/.test(identifier)) {
    throw new AppError(400, 'INVALID_CLICKHOUSE_IDENTIFIER', 'Invalid ClickHouse identifier');
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function safeClickHouseType(type: string): string {
  if (!type || type.length > 1000 || /[\0\r\n{}']/u.test(type)) {
    throw new AppError(400, 'INVALID_CLICKHOUSE_TYPE', 'Unsupported ClickHouse column type');
  }
  return type;
}

export function clickHouseVersionAtLeast(version: string, minimum: [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.', 3).map((part) => Number.parseInt(part, 10) || 0);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

export function isClickHouseMergeTreeEngine(engine: string): boolean {
  return engine.toLowerCase().includes('mergetree');
}

export function hasClickHouseLightweightUpdateColumns(createTableQuery: string): boolean {
  return /\benable_block_number_column\s*=\s*(?:1|true)\b/i.test(createTableQuery);
}
