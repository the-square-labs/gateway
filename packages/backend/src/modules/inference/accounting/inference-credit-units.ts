export const PUBLIC_CREDIT_SCALE = 1_000;

export function toPublicCredits(value: string | number): number {
  return Number(value) / PUBLIC_CREDIT_SCALE;
}

export function toPublicCreditString(value: string | number): string {
  return String(toPublicCredits(value));
}

export function toInternalCredits(value: number): number {
  return value * PUBLIC_CREDIT_SCALE;
}
