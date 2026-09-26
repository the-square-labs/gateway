import { waitFor } from "@testing-library/react";

/**
 * Waits until the page shows every given text anywhere in its DOM (text split
 * across styled spans still counts). On timeout it prints what the page shows
 * instead, so a missing fixture is easy to spot.
 */
export async function waitForPageText(...texts: string[]) {
  try {
    await waitFor(() => {
      const content = document.body.textContent ?? "";
      const missing = texts.filter((text) => !content.includes(text));
      if (missing.length) throw new Error(`page does not show: ${missing.join(", ")}`);
    });
  } catch (error) {
    if (process.env.DESIGN_SCREENS_TRACE) {
      process.stderr.write(
        `[design-screens] page text: ${(document.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 4000)}\n`
      );
    }
    throw error;
  }
}

/** Waits until a form field (an editable grid cell, a settings input) holds the value. */
export async function waitForFieldValue(value: string) {
  await waitFor(() => {
    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
    );
    if (!fields.some((field) => field.value === value)) {
      throw new Error(`no field holds: ${value}`);
    }
  });
}
