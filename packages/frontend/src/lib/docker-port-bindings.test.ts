import { describe, expect, it } from "vitest";
import { deriveDockerPortBindAddressOptions } from "./docker-port-bindings";

describe("deriveDockerPortBindAddressOptions", () => {
  it("returns all interfaces, loopback, and addresses grouped by their reported interface", () => {
    expect(
      deriveDockerPortBindAddressOptions({
        capabilities: { capabilities: ["docker_port_bind_ip_v1"] },
        liveHealthReport: {
          networkInterfaces: [
            { name: "eth0", ipAddresses: ["192.168.1.20"] },
            { name: "wg0", ipAddresses: ["10.10.0.2", "192.168.1.20"] },
          ],
        },
      } as never)
    ).toEqual([
      { value: "0.0.0.0", label: "All interfaces (0.0.0.0)" },
      { value: "127.0.0.1", label: "Loopback (127.0.0.1)" },
      { value: "192.168.1.20", label: "eth0 (192.168.1.20)" },
      { value: "10.10.0.2", label: "wg0 (10.10.0.2)" },
    ]);
  });

  it("offers only the compatible default for an older daemon", () => {
    expect(deriveDockerPortBindAddressOptions({ capabilities: {} } as never)).toEqual([
      { value: "0.0.0.0", label: "All interfaces (0.0.0.0)" },
    ]);
  });
});
