export function cleanPlanStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function cleanOptionalPlanValue(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}
