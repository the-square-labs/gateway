import { useNavigate } from "react-router-dom";
import { useUIStore } from "@/stores/ui";
import { PageBackButton } from "./PageBackButton";

export function LiteModeBackButton() {
  const aiLiteMode = useUIStore((state) => state.aiLiteMode);
  const navigate = useNavigate();

  if (!aiLiteMode) return null;

  return <PageBackButton label="Back to Work Session" onClick={() => navigate("/")} />;
}
