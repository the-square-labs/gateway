import { act, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import { HostingIntegrationsSection } from "./HostingIntegrationsSection";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
const connector = {
  id: "do",
  name: "DO test",
  provider: "digitalocean",
  enabled: true,
  syncStatus: "success",
  syncedAt: null,
  testedAt: null,
};
it("keeps loaded integration rows mounted while background refresh is pending or fails", async () => {
  useAuthStore.setState({ user: makeUser({ scopes: ["integrations:hosting:view"] }) });
  const list = vi.spyOn(api, "listHostingConnectors").mockResolvedValue([connector] as any);
  renderWithRouter(<HostingIntegrationsSection />);
  const row = await screen.findByRole("link", { name: "Open DO test" });
  let reject!: (error: Error) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  const refresh = vi
    .mocked(useRealtime)
    .mock.calls.find((call) => call[0] === "integration.connector.changed")![1];
  await act(async () => refresh?.({ id: "do", provider: "hosting" }));
  expect(screen.getByRole("link", { name: "Open DO test" })).toBe(row);
  await act(async () => reject(Error("Temporary failure")));
  expect(screen.getByRole("link", { name: "Open DO test" })).toBe(row);
  list.mockResolvedValueOnce([{ ...connector, syncStatus: "running" }] as any);
  await act(async () => refresh?.({ id: "do", provider: "hosting" }));
  await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Open DO test" })).toBe(row);
});
