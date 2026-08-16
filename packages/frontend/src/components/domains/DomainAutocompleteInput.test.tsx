import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { DomainAutocompleteInput } from "./DomainAutocompleteInput";

describe("DomainAutocompleteInput", () => {
  it("refreshes suggestions when a new instance mounts", async () => {
    const searchDomains = vi
      .spyOn(api, "searchDomains")
      .mockResolvedValueOnce([
        {
          id: "old",
          domain: "old.example",
          dnsStatus: "unknown",
          dnsProvider: "legacy",
          nginxNodeId: "node-1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "new",
          domain: "new.example",
          dnsStatus: "unknown",
          dnsProvider: "cloudflare",
          nginxNodeId: "node-1",
        },
      ]);

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
      {
        id: "new",
        domain: "new.example",
        dnsStatus: "unknown",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-1",
      },
      {
        id: "old",
        domain: "old.example",
        dnsStatus: "unknown",
        dnsProvider: "legacy",
        nginxNodeId: "node-1",
      },
    ]);

    render(<DomainAutocompleteInput value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("combobox"));

    const newest = await screen.findByText("new.example");
    const oldest = screen.getByText("old.example");
    expect(newest.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows only domains assigned to the selected Nginx node", async () => {
    vi.spyOn(api, "searchDomains").mockResolvedValue([
      {
        id: "domain-1",
        domain: "one.example",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-1",
      },
      {
        id: "domain-2",
        domain: "two.example",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-2",
      },
    ]);

    render(<DomainAutocompleteInput value="" onChange={vi.fn()} nginxNodeId="node-1" />);
    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("button", { name: /one\.example/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /two\.example/i })).not.toBeInTheDocument();
  });

  it("clears a selected registered domain when the Nginx node changes", async () => {
    vi.spyOn(api, "searchDomains").mockResolvedValue([
      {
        id: "domain-2",
        domain: "two.example",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-2",
      },
    ]);
    const onChange = vi.fn();
    const dialog = render(<DomainAutocompleteInput value="two.example" onChange={onChange} />);
    await waitFor(() => expect(api.searchDomains).toHaveBeenCalled());

    dialog.rerender(
      <DomainAutocompleteInput value="two.example" onChange={onChange} nginxNodeId="node-1" />
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
  });
});
