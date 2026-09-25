import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import {
  awsCliQuickStart,
  rcloneQuickStart,
  StorageCredentialsDialog,
} from "./StorageCredentialsDialog";

const SECRET = "secret-value-123";
const quickStart = {
  profile: "app-storage",
  endpoint: "https://10.0.0.5:9000",
  region: "us-east-1",
  accessKey: "root-key",
  secretKey: SECRET,
  engine: "seaweedfs" as const,
};

const CA = {
  certificatePem: "-----BEGIN CERTIFICATE-----\nSTORAGE-CA\n-----END CERTIFICATE-----",
  fingerprintSha256: "AB:CD:EF:01",
};

function renderDialog(tlsEnabled: boolean) {
  vi.spyOn(api, "revealManagedObjectStorageCredentials").mockResolvedValue({
    accessKey: "root-key",
    secretKey: SECRET,
  });
  return render(
    <StorageCredentialsDialog
      managedId="cluster-1"
      endpoint={tlsEnabled ? "https://10.0.0.5:9000" : "http://10.0.0.5:9000"}
      region="us-east-1"
      engine="seaweedfs"
      tlsEnabled={tlsEnabled}
      publishedPort={9000}
      connectionName="App Storage"
      open
      onOpenChange={() => {}}
    />
  );
}

afterEach(() => vi.restoreAllMocks());

describe("managed storage quick start", () => {
  it("configures the AWS CLI with the endpoint and path-style addressing", () => {
    expect(awsCliQuickStart(quickStart)).toBe(
      [
        "aws configure set aws_access_key_id root-key --profile app-storage",
        `aws configure set aws_secret_access_key ${SECRET} --profile app-storage`,
        "aws configure set region us-east-1 --profile app-storage",
        "aws configure set s3.addressing_style path --profile app-storage",
        "aws s3 ls --profile app-storage --endpoint-url https://10.0.0.5:9000",
      ].join("\n")
    );
  });

  it("creates an rclone remote for the cluster engine with path-style addressing", () => {
    expect(rcloneQuickStart(quickStart)).toBe(
      [
        `rclone config create app-storage s3 provider=SeaweedFS access_key_id=root-key secret_access_key=${SECRET} endpoint=https://10.0.0.5:9000 region=us-east-1 force_path_style=true no_check_bucket=true`,
        "rclone lsd app-storage:",
      ].join("\n")
    );
    const minio = rcloneQuickStart({ ...quickStart, engine: "minio" });
    expect(minio).toContain("provider=Minio ");
    expect(minio).toContain("force_path_style=true no_check_bucket=true");
  });

  it("shows AWS CLI and rclone examples with the secret masked instead of mc", async () => {
    vi.spyOn(api, "revealManagedObjectStorageCredentials").mockResolvedValue({
      accessKey: "root-key",
      secretKey: SECRET,
    } as never);
    render(
      <StorageCredentialsDialog
        managedId="cluster-1"
        endpoint="https://10.0.0.5:9000"
        region="us-east-1"
        engine="seaweedfs"
        publishedPort={9000}
        connectionName="App Storage"
        open
        onOpenChange={() => {}}
      />
    );
    expect(await screen.findByText("AWS CLI")).toBeVisible();
    expect(screen.getByText("rclone")).toBeVisible();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "aws s3 ls --profile app-storage --endpoint-url https://10.0.0.5:9000"
    );
    expect(dialog).toHaveTextContent("force_path_style=true no_check_bucket=true");
    expect(dialog).toHaveTextContent("aws_secret_access_key ******** --profile app-storage");
    expect(dialog).not.toHaveTextContent(SECRET);
    expect(dialog).not.toHaveTextContent("mc alias");
  });
});

describe("managed storage CA certificate", () => {
  it("adds the downloaded CA to both quick start commands", () => {
    const withCa = { ...quickStart, caBundle: "storage-ca.pem" };
    expect(awsCliQuickStart(withCa)).toContain(
      "aws s3 ls --profile app-storage --endpoint-url https://10.0.0.5:9000 --ca-bundle storage-ca.pem"
    );
    expect(rcloneQuickStart(withCa)).toContain("rclone lsd app-storage: --ca-cert storage-ca.pem");
    expect(awsCliQuickStart(quickStart)).not.toContain("--ca-bundle");
    expect(rcloneQuickStart(quickStart)).not.toContain("--ca-cert");
  });

  it("shows the fingerprint, downloads storage-ca.pem and extends the quick start when TLS is on", async () => {
    const getCa = vi.spyOn(api, "getManagedObjectStorageCaCertificate").mockResolvedValue(CA);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloads.push(this.download);
    });
    renderDialog(true);

    expect(await screen.findByLabelText("CA fingerprint (SHA-256)")).toHaveValue("AB:CD:EF:01");
    expect(getCa).toHaveBeenCalledWith("cluster-1");
    expect(screen.getByRole("button", { name: "Copy CA certificate" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download CA certificate" }));
    expect(downloads).toEqual(["storage-ca.pem"]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "--endpoint-url https://10.0.0.5:9000 --ca-bundle storage-ca.pem"
    );
    expect(dialog).toHaveTextContent("rclone lsd app-storage: --ca-cert storage-ca.pem");
  });

  it("hides the CA when TLS is off", async () => {
    const getCa = vi.spyOn(api, "getManagedObjectStorageCaCertificate");
    renderDialog(false);
    expect(await screen.findByText("AWS CLI")).toBeVisible();
    expect(getCa).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("CA certificate")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent("--ca-bundle");
  });

  it("treats a 409 from the CA endpoint as TLS off without an error", async () => {
    vi.spyOn(api, "getManagedObjectStorageCaCertificate").mockRejectedValue(
      new ApiRequestError("TLS is disabled", { status: 409, code: "MANAGED_STORAGE_TLS_DISABLED" })
    );
    renderDialog(true);
    expect(await screen.findByText("AWS CLI")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByLabelText("CA fingerprint (SHA-256)")).not.toBeInTheDocument()
    );
    expect(screen.queryByText(/CA certificate could not be loaded/)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent("--ca-cert");
  });
});
