import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { ManagedObjectStorageCreateInput } from "@/types";
import { ManagedObjectStorageCreateForm } from "./Storage";

function Form() {
  const [draft, setDraft] = useState<ManagedObjectStorageCreateInput>({
    name: "App Storage",
    version: "test",
    nodeId: "n1",
    storageSizeGb: 32,
    cpuCores: 2,
    memoryMb: 2048,
    swapMb: 0,
    publishedPort: 9000,
    publishS3: false,
    sftpEnabled: false,
    ftpEnabled: false,
  });
  return (
    <ManagedObjectStorageCreateForm
      draft={draft}
      nodes={[]}
      catalog={[]}
      capacity={{ maxStorageGb: 64, maxCpuCores: 4, maxMemoryMb: 4096, maxSwapMb: 0 }}
      step={3}
      onChange={setDraft}
    />
  );
}

describe("managed storage connectivity step", () => {
  it("only exposes settings for enabled protocols and preserves entered ports", () => {
    render(<Form />);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    const port = screen.getByRole("spinbutton", { name: "S3 API port" });
    expect(port).toHaveValue(9000);
    fireEvent.change(port, { target: { value: "9001" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    expect(screen.queryByRole("spinbutton", { name: "S3 API port" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    expect(screen.getByRole("spinbutton", { name: "S3 API port" })).toHaveValue(9001);
    fireEvent.click(screen.getByRole("button", { name: "SFTP access" }));
    expect(screen.getByRole("spinbutton", { name: "SFTP port" })).toHaveValue(8022);
    fireEvent.click(screen.getByRole("button", { name: "FTP access" }));
    expect(screen.getByRole("spinbutton", { name: "FTP port" })).toHaveValue(2121);
    expect(screen.getByRole("spinbutton", { name: "FTP passive port range start" })).toHaveValue(
      30000
    );
    expect(screen.getByRole("spinbutton", { name: "FTP passive port count" })).toHaveValue(10);
  });
});
