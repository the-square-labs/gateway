import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { DomainAutocompleteInput } from "./DomainAutocompleteInput";

describe("DomainAutocompleteInput", () => {
  it("refreshes suggestions when a new instance mounts", async () => {
    const searchDomains = vi
      .spyOn(api, "searchDomains")
      .mockResolvedValueOnce([{ id: "old", domain: "old.example", dnsStatus: "unknown" }])
      .mockResolvedValueOnce([{ id: "new", domain: "new.example", dnsStatus: "unknown" }]);

    const first = render(<DomainAutocompleteInput value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("button", { name: /old\.example/i })).toBeInTheDocument();
    await waitFor(() => expect(searchDomains).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<DomainAutocompleteInput value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchDomains).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("button", { name: /new\.example/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /old\.example/i })).not.toBeInTheDocument();
  });

  it("shows newly created domains before older domains", async () => {
    vi.spyOn(api, "searchDomains").mockResolvedValue([
      { id: "new", domain: "new.example", dnsStatus: "unknown" },
      { id: "old", domain: "old.example", dnsStatus: "unknown" },
    ]);

    render(<DomainAutocompleteInput value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("combobox"));

    const newest = await screen.findByText("new.example");
    const oldest = screen.getByText("old.example");
    expect(newest.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
