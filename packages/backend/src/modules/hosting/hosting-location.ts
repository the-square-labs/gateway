const countries = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** Presentation only: provider IDs remain unchanged for filtering, prices and requests. */
export function hostingLocationLabel(code: string, city?: string, countryCode?: string): string {
  const country =
    countryCode && /^[A-Za-z]{2}$/.test(countryCode) ? countries.of(countryCode.toUpperCase()) : undefined;
  const parts = [...new Set([city?.trim(), country].filter((part): part is string => Boolean(part)))];
  return parts.length ? `${parts.join(', ')} (${code})` : code;
}
