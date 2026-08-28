export function isSidebarNavigationActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
