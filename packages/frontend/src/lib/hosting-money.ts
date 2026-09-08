/** Display provider decimals without padding; never round quotes or sub-cent hourly prices. */
export function formatHostingAmount(amount: string): string {
  const normalized = amount.trim();
  if (!/^-?\d+\.\d+$/.test(normalized)) return normalized;
  const [integer, fraction] = normalized.split(".");
  const significant = fraction!.replace(/0+$/, "");
  return significant ? `${integer}.${significant}` : integer!;
}
