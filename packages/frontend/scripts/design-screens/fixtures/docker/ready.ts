import { screen, waitFor, within } from "@testing-library/react";

/** Waits until the page shows every given text anywhere in its DOM (split spans count). */
export async function waitForText(...texts: string[]) {
  await waitFor(() => {
    const content = document.body.textContent ?? "";
    const missing = texts.filter((text) => !content.includes(text));
    if (missing.length) throw new Error(`page does not show: ${missing.join(", ")}`);
  });
}

/** Lets late requests, timers and editor mounts settle before a capture without a reveal gate. */
export const pause = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

type User = {
  click: (element: Element) => Promise<void>;
  clear: (element: Element) => Promise<void>;
  paste: (text: string) => Promise<void>;
};

/** Opens the dialog's select that shows `placeholder` and picks the option matching `option`. */
export async function pickOption(
  user: User,
  dialog: HTMLElement,
  placeholder: string,
  option: RegExp
) {
  const trigger = within(dialog)
    .getAllByRole("combobox")
    .find((element) => element.textContent?.includes(placeholder));
  if (!trigger) throw new Error(`no select shows "${placeholder}"`);
  await user.click(trigger);
  try {
    await user.click(await screen.findByRole("option", { name: option }, { timeout: 3_000 }));
  } catch (error) {
    const offered = screen.queryAllByRole("option").map((item) => item.textContent);
    throw new Error(
      `no option ${option} in [${offered.join(", ")}]: ${String(error).slice(0, 80)}`
    );
  }
}

/** Replaces the value of the dialog field that has the given placeholder (pasted: one render). */
export async function fillField(
  user: User,
  dialog: HTMLElement,
  placeholder: string,
  value: string
) {
  const field = within(dialog).getByPlaceholderText(placeholder);
  await user.clear(field);
  await user.click(field);
  await user.paste(value);
}
