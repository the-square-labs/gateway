import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { confirmAndDeleteNode } from "./remove-node";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));

describe("confirmAndDeleteNode", () => {
  beforeEach(() => {
    vi.mocked(confirm).mockReset();
    vi.restoreAllMocks();
  });

  it("cascades proxy hosts after explicit confirmation for an offline Nginx node", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const deleteNode = vi
      .spyOn(api, "deleteNode")
      .mockRejectedValueOnce(
        new ApiRequestError("Offline node has proxy hosts", {
          status: 409,
          code: "OFFLINE_NGINX_NODE_HAS_HOSTS",
          details: { proxyHostCount: 2 },
        })
      )
      .mockResolvedValueOnce(undefined);

    await expect(confirmAndDeleteNode("node-1", "edge-1")).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Remove Offline Nginx Node",
        description: expect.stringContaining("2 assigned proxy hosts"),
        confirmLabel: "Remove Node and Proxies",
      })
    );
    expect(deleteNode).toHaveBeenNthCalledWith(1, "node-1");
    expect(deleteNode).toHaveBeenNthCalledWith(2, "node-1", { cascadeProxyHosts: true });
  });

  it("keeps the node when cascade removal is not confirmed", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deleteNode = vi.spyOn(api, "deleteNode").mockRejectedValueOnce(
      new ApiRequestError("Offline node has proxy hosts", {
        status: 409,
        code: "OFFLINE_NGINX_NODE_HAS_HOSTS",
        details: { proxyHostCount: 1 },
      })
    );

    await expect(confirmAndDeleteNode("node-1", "edge-1")).resolves.toBe(false);
    expect(deleteNode).toHaveBeenCalledOnce();
  });
});
