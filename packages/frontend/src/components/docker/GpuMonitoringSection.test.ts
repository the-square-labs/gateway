import { describe, expect, it } from "vitest";
import { gpuTemperatureProgressPercent } from "./GpuMonitoringSection";

describe("gpuTemperatureProgressPercent", () => {
  it("maps the 20–100°C range and clamps values outside it", () => {
    expect(gpuTemperatureProgressPercent(10)).toBe(0);
    expect(gpuTemperatureProgressPercent(20)).toBe(0);
    expect(gpuTemperatureProgressPercent(60)).toBe(50);
    expect(gpuTemperatureProgressPercent(100)).toBe(100);
    expect(gpuTemperatureProgressPercent(120)).toBe(100);
  });
});
