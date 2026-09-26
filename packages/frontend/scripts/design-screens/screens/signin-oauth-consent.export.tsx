import { screen } from "@testing-library/react";
import { OAUTH_REQUEST_ID, oauthConsentHandlers } from "../fixtures/signin/oauth";
import { exportScreen } from "../harness";

it("signin-oauth-consent", async () => {
  await exportScreen({
    id: "signin-oauth-consent",
    title: "OAuth consent",
    group: "Sign-in",
    route: `/oauth/consent?request=${OAUTH_REQUEST_ID}`,
    handlers: oauthConsentHandlers(),
    height: 1100,
    ready: async () => {
      await screen.findByText("Release Bot");
    },
    notes: [
      "An external CI client asks for container and route access; route editing needs explicit approval.",
    ],
  });
});
