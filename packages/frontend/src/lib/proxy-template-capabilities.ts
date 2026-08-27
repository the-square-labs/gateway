export function supportsPagesRouteTemplate(content: string): boolean {
  return /include\s+{{\s*pagesRouteIncludePath\s*}}\s*;/.test(content);
}
