/** Bounded form feedback only. The backend independently validates and allocates every resource. */
export function previewHostingPool(value: string, kind: "vmid" | "ipv4"): number[] {
  if (!value.trim()) return [];
  const parse = (part: string): number => {
    if (kind === "vmid") {
      if (!/^\d+$/.test(part)) throw new Error("Use VMIDs or ranges, for example 250-260,271.");
      const id = Number(part);
      if (!Number.isSafeInteger(id) || id < 100 || id > 999999999)
        throw new Error("VMIDs must be between 100 and 999999999.");
      return id;
    }
    const octets = part.split(".");
    if (
      octets.length !== 4 ||
      octets.some((octet) => !/^(0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255)
    )
      throw new Error(
        "Use IPv4 addresses or full address ranges, for example 192.0.2.100-192.0.2.119."
      );
    return octets.reduce((address, octet) => address * 256 + Number(octet), 0);
  };
  const values = new Set<number>();
  for (const entry of value.split(/[,\n]/)) {
    const parts = entry.trim().split(/\s*-\s*/);
    if (parts.length > 2 || parts.some((part) => !part))
      throw new Error("Remove empty or incomplete ranges.");
    const first = parse(parts[0]);
    const last = parts.length === 2 ? parse(parts[1]) : first;
    if (last < first) throw new Error("Range end must not be smaller than its start.");
    if (last - first >= 1000) throw new Error("A pool can contain at most 1000 unique values.");
    for (let item = first; item <= last; item++) {
      values.add(item);
      if (values.size > 1000) throw new Error("A pool can contain at most 1000 unique values.");
    }
  }
  return [...values].sort((a, b) => a - b);
}
