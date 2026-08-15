import { useEffect, useMemo, useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { api } from "@/services/api";
import type {
  Domain,
  DomainSearchResult,
  FolderTreeNode,
  GroupedProxyHostsResponse,
} from "@/types";
import { DnsStatusBadge } from "./DnsStatusBadge";

function mapDomains(domains: Domain[]): DomainSearchResult[] {
  return [...domains]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((domain) => ({
      id: domain.id,
      domain: domain.domain,
      dnsStatus: domain.dnsStatus,
      dnsProvider: domain.dnsProvider,
      nginxNodeId: domain.nginxNodeId,
    }));
}

function collectFolderDomains(folder: FolderTreeNode, domains: Set<string>) {
  for (const host of folder.hosts) {
    for (const domain of host.domainNames) domains.add(domain);
  }
  for (const child of folder.children) collectFolderDomains(child, domains);
}

function getCachedDomainSuggestions() {
  const cachedDomainList =
    api.getCached<{ data: Domain[] }>("domains:list:folder-view") ??
    api.getCached<{ data: Domain[] }>("domains:list");
  if (cachedDomainList?.data?.length) return mapDomains(cachedDomainList.data);
  return [];
}

function getProxyHostDomainSuggestions() {
  const groupedProxyHosts = api.getCached<GroupedProxyHostsResponse>("proxy:grouped");
  if (!groupedProxyHosts) return [];

  const domains = new Set<string>();
  for (const host of groupedProxyHosts.ungroupedHosts) {
    for (const domain of host.domainNames) domains.add(domain);
  }
  for (const folder of groupedProxyHosts.folders) collectFolderDomains(folder, domains);

  return Array.from(domains)
    .sort((a, b) => a.localeCompare(b))
    .map((domain) => ({
      id: domain,
      domain,
      dnsStatus: "unknown" as const,
      dnsProvider: "legacy" as const,
      nginxNodeId: null,
    }));
}

function loadDomainSuggestions(registeredOnly: boolean) {
  return api
    .searchDomains("")
    .catch(() => [])
    .then((domains) =>
      domains.length > 0 || registeredOnly ? domains : getProxyHostDomainSuggestions()
    );
}

interface DomainAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputClassName?: string;
  registeredOnly?: boolean;
  nginxNodeId?: string;
  onDomainSelect?: (domain: DomainSearchResult | null) => void;
}

export function DomainAutocompleteInput({
  value,
  onChange,
  placeholder = "example.com",
  inputClassName,
  registeredOnly = false,
  nginxNodeId,
  onDomainSelect,
}: DomainAutocompleteInputProps) {
  const [domains, setDomains] = useState<DomainSearchResult[]>(getCachedDomainSuggestions);

  useEffect(() => {
    let cancelled = false;
    void loadDomainSuggestions(registeredOnly).then((loadedDomains) => {
      if (!cancelled) setDomains(loadedDomains);
    });
    return () => {
      cancelled = true;
    };
  }, [registeredOnly]);

  useEffect(() => {
    if (!nginxNodeId || !value.trim()) return;
    const normalizedValue = value.trim().toLowerCase();
    const selectedDomain = domains.find(
      (domain) => domain.domain.trim().toLowerCase() === normalizedValue
    );
    if (!selectedDomain || selectedDomain.nginxNodeId === nginxNodeId) return;
    onChange("");
    onDomainSelect?.(null);
  }, [domains, nginxNodeId, onChange, onDomainSelect, value]);

  const options = useMemo<ComboboxOption[]>(
    () =>
      domains
        .filter((domain) => !nginxNodeId || domain.nginxNodeId === nginxNodeId)
        .slice(0, 100)
        .map((domain) => ({
          value: domain.domain,
          label: domain.domain,
        })),
    [domains, nginxNodeId]
  );

  return (
    <Combobox
      freeText={!registeredOnly}
      value={value}
      options={options}
      onValueChange={(nextValue) => {
        onChange(nextValue);
        onDomainSelect?.(domains.find((candidate) => candidate.domain === nextValue) ?? null);
      }}
      placeholder={placeholder}
      searchPlaceholder={placeholder}
      emptyMessage="No matching domains."
      className="flex-1"
      inputClassName={inputClassName}
      contentClassName="max-h-40"
      renderOption={(option) => {
        const domain = domains.find((candidate) => candidate.domain === option.value);
        return (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {domain && <DnsStatusBadge status={domain.dnsStatus} />}
          </span>
        );
      }}
    />
  );
}
