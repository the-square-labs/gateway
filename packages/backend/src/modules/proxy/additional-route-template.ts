export const ADDITIONAL_ROUTES_TEMPLATE_PLACEHOLDER =
  '{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}';

const ADDITIONAL_ROUTES_TEMPLATE_PLACEHOLDER_PATTERN =
  /{{{\s*renderAdditionalRoutes\s+additionalRoutes\s+id\s+accessList\s+rateLimitEnabled\s+rateLimitBurst\s+connectionsPerIp\s*}}}/;

export function supportsAdditionalRoutesTemplate(content: string): boolean {
  return ADDITIONAL_ROUTES_TEMPLATE_PLACEHOLDER_PATTERN.test(content);
}

const PAGES_ROUTE_INCLUDE_PATTERN = /include\s+{{\s*pagesRouteIncludePath\s*}}\s*;/;

export function supportsPagesRouteTemplate(content: string): boolean {
  return PAGES_ROUTE_INCLUDE_PATTERN.test(content);
}
