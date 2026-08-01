import type { SqlColumnMetadata } from "@/types";

type PostgresColumnLike = SqlColumnMetadata & { udtName?: string };

export const POSTGRES_COLUMN_TYPE_OPTIONS = [
  "text",
  "varchar(255)",
  "varchar(1024)",
  "char(1)",
  "boolean",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "numeric(12,2)",
  "real",
  "double precision",
  "date",
  "time",
  "time with time zone",
  "timestamp",
  "timestamp with time zone",
  "uuid",
  "json",
  "jsonb",
  "bytea",
  "inet",
  "cidr",
  "macaddr",
  "xml",
];

export const POSTGRES_SEARCH_OPERATIONS = [
  { value: "like", label: "LIKE" },
  { value: "equals", label: "=" },
  { value: "notEquals", label: "!=" },
  { value: "greaterThan", label: ">" },
  { value: "lessThan", label: "<" },
] as const;

export type PostgresSearchOperation = (typeof POSTGRES_SEARCH_OPERATIONS)[number]["value"];

export type NewColumnDraft = {
  id: string;
  name: string;
  dataType: string;
};

export const POSTGRES_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const POSTGRES_UDT_TYPE_ALIASES = new Map<string, string>([
  ["int2", "smallint"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["bool", "boolean"],
  ["float4", "real"],
  ["float8", "double precision"],
  ["bpchar", "character"],
  ["varchar", "character varying"],
  ["timestamp", "timestamp"],
  ["timestamptz", "timestamp with time zone"],
  ["time", "time"],
  ["timetz", "time with time zone"],
]);

export function createNewColumnDraft(): NewColumnDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "",
    dataType: "text",
  };
}

export function normalizeColumnType(dataType: string) {
  return dataType.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizePostgresTypeAlias(typeName: string) {
  const normalized = normalizeColumnType(typeName);
  return POSTGRES_UDT_TYPE_ALIASES.get(normalized) ?? normalized;
}

export function currentColumnTypeValue(column: PostgresColumnLike) {
  const normalized = normalizeColumnType(column.dataType);
  if (normalized === "timestamp without time zone") return "timestamp";
  if (normalized === "time without time zone") return "time";
  return normalized;
}

export function secondaryColumnTypeLabel(column: PostgresColumnLike) {
  const nativeTypeName = column.nativeTypeName ?? column.udtName;
  if (!nativeTypeName) return "";
  const normalizedUdtName = normalizeColumnType(nativeTypeName);
  const normalizedDataType = normalizeColumnType(column.dataType);
  const canonicalUdtName = normalizePostgresTypeAlias(nativeTypeName);
  const canonicalDataType = normalizePostgresTypeAlias(column.dataType);
  const currentType = normalizePostgresTypeAlias(currentColumnTypeValue(column));
  if (
    normalizedUdtName === normalizedDataType ||
    canonicalUdtName === canonicalDataType ||
    canonicalUdtName === currentType
  ) {
    return "";
  }
  return nativeTypeName;
}
