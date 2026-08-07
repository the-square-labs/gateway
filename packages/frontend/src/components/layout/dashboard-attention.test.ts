import { dashboardAttentionDotClass, dashboardAttentionLabel } from "./dashboard-attention";

describe("dashboard attention appearance", () => {
  it.each([
    ["critical", "bg-destructive", "Dashboard has a critical system issue"],
    ["warning", "bg-warning", "Dashboard requires attention"],
    ["info", "bg-[color:var(--color-link)]", "Dashboard has setup information"],
  ] as const)("maps %s to its color and accessible label", (severity, color, label) => {
    expect(dashboardAttentionDotClass(severity)).toBe(color);
    expect(dashboardAttentionLabel(severity)).toBe(label);
  });
});
