import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { managedStorages } from "../fixtures/data/storage";
import { chooseOption, dialogComboboxInputs, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-add-binding-storage", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-add-binding-storage",
    title: "Route · Add Binding (managed S3)",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [
      http.get("*/api/managed-storage", () => wrapped(managedStorages)),
      ...routeHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /Add binding/ }));
      const dialog = await settleDialog("Add Binding");
      await user.type(within(dialog).getByPlaceholderText("api"), "backups");
      await chooseOption(
        user,
        within(dialog).getByRole("combobox", { name: "Target" }),
        "Managed S3 storage"
      );
      // The storage picker stays disabled until the managed storages have loaded.
      const storage = dialogComboboxInputs(dialog)[0] as HTMLInputElement;
      await waitFor(() => expect(storage.disabled).toBe(false));
      await user.click(storage);
      await user.click(await screen.findByRole("button", { name: managedStorages[0].name }));
    },
    notes: ["A Secure Link to the managed SeaweedFS storage, reached privately through Relay."],
  });
});
