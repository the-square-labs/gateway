import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { rememberGatewayReloadToken, stripGatewayReloadParam } from "@/lib/gateway-update-reload";
import { registerAuthContextReset } from "@/stores/auth";
import { resetClientSessionState } from "@/stores/session-reset";
import App from "./App";
import "./index.css";

registerAuthContextReset(resetClientSessionState);

// Strip cache-bust param added by update reload
rememberGatewayReloadToken(window.location.href);
const cleanReloadUrl = stripGatewayReloadParam(window.location.href);
if (cleanReloadUrl != null) {
  window.history.replaceState(null, "", cleanReloadUrl);
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
