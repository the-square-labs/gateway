import { screen } from "@testing-library/react";
import { authCertificate, pkiHandlers } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-certificate-detail", async () => {
  await exportScreen({
    id: "certs-certificate-detail",
    title: "Certificate",
    group: "Certificates",
    route: `/certificates/${authCertificate.id}`,
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    ready: async () => {
      await screen.findByText("Serial Number");
    },
    notes: ["A server certificate for auth.example.com with DNS and IP SANs."],
  });
});
