import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';
import { AppError } from '@/middleware/error-handler.js';

export function normalizePagesHostname(value: string): string {
  const hostname = domainToASCII(value.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''));
  if (!hostname) throw new AppError(400, 'PAGES_DOMAIN_INVALID', 'Pages domain is invalid');
  return hostname;
}

export function registrableDomain(value: string): string {
  const hostname = normalizePagesHostname(value);
  const domain = getDomain(hostname, { allowPrivateDomains: true, extractHostname: false });
  if (!domain) throw new AppError(400, 'PAGES_DOMAIN_NOT_REGISTRABLE', 'Pages requires a registrable public domain');
  return domain;
}

export function compareRegistrableDomains(gatewayHost: string, pagesHost: string) {
  const normalizedGatewayHost = normalizePagesHostname(gatewayHost);
  const normalizedPagesHost = normalizePagesHostname(pagesHost);
  const gatewayRegistrableDomain = getDomain(normalizedGatewayHost, {
    allowPrivateDomains: true,
    extractHostname: false,
  });
  const pagesRegistrableDomain = registrableDomain(normalizedPagesHost);
  return {
    gatewayHost: normalizedGatewayHost,
    pagesHost: normalizedPagesHost,
    gatewayRegistrableDomain,
    pagesRegistrableDomain,
    same: gatewayRegistrableDomain !== null && gatewayRegistrableDomain === pagesRegistrableDomain,
  };
}
