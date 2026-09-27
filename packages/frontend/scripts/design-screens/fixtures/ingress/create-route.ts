/**
 * Walks the Create Route dialog (`/proxy-hosts/new`): step 1 picks the type,
 * the Frankfurt edge and the domain names, then Next opens step 2.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import type { UserEventApi } from "../../harness";
import { releaseAnimatedHeights } from "../docker/jsdom-shims";
import { chooseOption, dialogComboboxInputs, dialogSelects, toggleSetting } from "./interactions";

export async function openCreateRouteDialog() {
  await screen.findByText("legacy-admin.example.com");
  const dialog = await screen.findByRole("dialog", { name: "Create Route" });
  await waitForReveal();
  return dialog;
}

interface EntrypointOptions {
  type?: "Proxy" | "Redirect" | "404";
  domains: string[];
  folder?: string;
}

/** Fills step 1; the dialog stays on it. */
export async function fillEntrypoint(
  user: UserEventApi,
  dialog: HTMLElement,
  { type, domains, folder }: EntrypointOptions
) {
  if (type && type !== "Proxy") await chooseOption(user, dialogSelects(dialog)[0], type);
  await chooseOption(
    user,
    within(dialog).getByRole("combobox", { name: "Ingress node" }),
    /Edge Frankfurt/
  );
  if (folder) {
    await chooseOption(user, within(dialog).getByRole("combobox", { name: "Folder" }), folder);
  }
  for (const [index, domain] of domains.entries()) {
    if (index > 0) await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    await user.type(dialogComboboxInputs(dialog)[index], domain);
    // Closes the suggestion list.
    await user.click(within(dialog).getByText("Domain Names"));
  }
}

/** Fills step 1 and moves to step 2 (target and TLS). */
export async function goToConfiguration(
  user: UserEventApi,
  dialog: HTMLElement,
  options: EntrypointOptions
) {
  await fillEntrypoint(user, dialog, options);
  await user.click(within(dialog).getByRole("button", { name: /Next/ }));
  await waitFor(() => expect(within(dialog).queryByText("Domain Names")).toBeNull());
  await waitForReveal();
}

/** Picks a certificate in the step 2 SSL block after switching SSL on. */
export async function enableSsl(user: UserEventApi, dialog: HTMLElement, certificate: RegExp) {
  await toggleSetting(user, dialog, "SSL Enabled");
  await user.click(within(dialog).getByRole("combobox", { name: "SSL Certificate" }));
  await user.click(await screen.findByRole("button", { name: certificate }));
}

export async function settleCreateRoute(dialog: HTMLElement) {
  await waitForReveal();
  await releaseAnimatedHeights(dialog);
}
