/** Compare bounded, non-negative provider decimals without binary floating point. */
export const HOSTING_DECIMAL = /^\d+(?:\.\d+)?$/;
export function hostingDecimal(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > 128 || !HOSTING_DECIMAL.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  return decimal ? `${integer}.${decimal}` : integer;
}

export function compareHostingDecimal(left: string, right: string): number | null {
  const a = hostingDecimal(left);
  const b = hostingDecimal(right);
  if (a === null || b === null) return null;
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  if (ai.length !== bi.length) return ai.length > bi.length ? 1 : -1;
  if (ai !== bi) return ai > bi ? 1 : -1;
  const width = Math.max(af.length, bf.length);
  const ad = af.padEnd(width, '0');
  const bd = bf.padEnd(width, '0');
  return ad === bd ? 0 : ad > bd ? 1 : -1;
}
