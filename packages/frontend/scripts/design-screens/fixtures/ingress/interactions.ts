/**
 * Interaction steps the Routes & Pages dialog boards share: open a dialog,
 * pick a select option, let the dialog settle before it is captured.
 */
import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import type { UserEventApi } from "../../harness";
import { releaseAnimatedHeights } from "../docker/jsdom-shims";

/** Waits for the named dialog, its reveal gate and its animated heights. */
export async function settleDialog(name: string | RegExp) {
  const dialog = await screen.findByRole("dialog", { name });
  await waitForReveal();
  await releaseAnimatedHeights(dialog);
  return dialog;
}

/** Runs an action of the page header's overflow menu (destructive ones always live there). */
export async function choosePageAction(user: UserEventApi, name: string | RegExp) {
  await user.click(screen.getByRole("button", { name: "Page actions" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

/** Opens a Radix select and picks one of its options. */
export async function chooseOption(
  user: UserEventApi,
  trigger: HTMLElement,
  option: string | RegExp
) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Select triggers (buttons) and comboboxes (inputs) of a dialog, in document order. */
export function dialogSelects(dialog: HTMLElement) {
  return within(dialog)
    .getAllByRole("combobox")
    .filter((element) => element.tagName === "BUTTON");
}

export function dialogComboboxInputs(dialog: HTMLElement) {
  return within(dialog)
    .getAllByRole("combobox")
    .filter((element) => element.tagName === "INPUT");
}

/**
 * Opens the action menu of the list row (or folder row) that shows `text` and
 * runs one of its items. The row is the nearest ancestor holding a button
 * labelled `menuLabel`.
 */
export async function chooseRowAction(
  user: UserEventApi,
  text: string,
  menuLabel: string,
  item: string | RegExp
) {
  let row: HTMLElement | null = screen.getAllByText(text)[0];
  while (row && !within(row).queryAllByRole("button", { name: menuLabel }).length) {
    row = row.parentElement;
  }
  if (!row) throw new Error(`no row with "${menuLabel}" holds "${text}"`);
  await user.click(within(row).getAllByRole("button", { name: menuLabel })[0]);
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

/** Flips the switch of the settings row titled `title`. */
export async function toggleSetting(user: UserEventApi, container: HTMLElement, title: string) {
  const row = within(container).getByText(title).closest(".grid");
  const toggle = row?.querySelector<HTMLButtonElement>("button[aria-pressed]");
  if (!toggle) throw new Error(`no switch in the "${title}" row`);
  await user.click(toggle);
}
