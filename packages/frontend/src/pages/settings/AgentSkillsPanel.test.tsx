import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AIAgentSkill } from "@/types/ai";
import { AgentSkillsPanel } from "./AgentSkillsPanel";

const SYSTEM_SKILL: AIAgentSkill = {
  id: "system:operations",
  name: "Infrastructure operations",
  description: "Operate Gateway resources",
  instructions: "Inspect before changing resources.",
  source: "system",
  enabled: true,
  createdAt: null,
  updatedAt: null,
};

const USER_SKILL: AIAgentSkill = {
  id: "skill-1",
  name: "Acme naming",
  description: "Naming rules",
  instructions: "Use the acme- prefix.",
  source: "user",
  enabled: true,
  createdAt: "2026-08-14T10:00:00.000Z",
  updatedAt: "2026-08-14T10:00:00.000Z",
};

const DISABLED_USER_SKILL: AIAgentSkill = {
  ...USER_SKILL,
  id: "skill-2",
  name: "Legacy naming",
  enabled: false,
};

describe("AgentSkillsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({
      user: {
        id: "user-1",
        oidcSubject: "user-1",
        email: "admin@example.com",
        name: "Admin",
        avatarUrl: null,
        groupId: "group-1",
        groupName: "admin",
        scopes: ["feat:ai:configure", "ai:skills:manage"],
        isBlocked: false,
      },
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "listAISkills").mockResolvedValue([
      SYSTEM_SKILL,
      USER_SKILL,
      DISABLED_USER_SKILL,
    ]);
  });

  it("reuses one settings list while keeping system skills immutable", async () => {
    render(<AgentSkillsPanel />);

    expect(await screen.findByText("Infrastructure operations")).toBeInTheDocument();
    const systemSkillsButton = screen.getByRole("button", { name: "System skills" });
    expect(systemSkillsButton).toHaveAttribute("aria-expanded", "false");
    expect(systemSkillsButton).not.toHaveClass("border-t");
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Infrastructure operations" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Acme naming" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete Acme naming" })).toBeEnabled();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skill enabled" })).not.toBeInTheDocument();
  });

  it("opens the entire skill row and edits manageable user skills directly", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(api, "updateAISkill").mockResolvedValue({
      ...USER_SKILL,
      enabled: false,
    });
    render(<AgentSkillsPanel />);

    await user.click(await screen.findByRole("button", { name: "System skills" }));
    expect(screen.getByRole("button", { name: "System skills" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Open Infrastructure operations" }));
    const systemDialog = screen.getByRole("dialog");
    expect(systemDialog).toHaveTextContent(
      "System skills are maintained by Gateway and cannot be changed or disabled."
    );
    expect(within(systemDialog).getByLabelText("Skill name")).toHaveAttribute("readonly");
    expect(within(systemDialog).getByLabelText("Skill description")).toHaveAttribute("readonly");
    expect(within(systemDialog).getByLabelText("Skill instructions")).toHaveAttribute("readonly");
    await user.click(within(systemDialog).getByText("Close", { selector: "button" }));

    await user.click(screen.getByRole("button", { name: "Open Acme naming" }));
    const userDialog = screen.getByRole("dialog");
    expect(userDialog).toHaveTextContent("Edit Agent Skill");
    const enabled = within(userDialog).getByRole("button", { name: "Skill enabled" });
    expect(enabled).toHaveAttribute("aria-pressed", "true");
    await user.click(enabled);
    await user.click(within(userDialog).getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("skill-1", {
        name: "Acme naming",
        description: "Naming rules",
        instructions: "Use the acme- prefix.",
        enabled: false,
      })
    );
  });

  it("creates a user skill through the standard dialog", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createAISkill").mockResolvedValue(USER_SKILL);
    render(<AgentSkillsPanel />);

    await screen.findByText("Infrastructure operations");
    await user.click(screen.getByRole("button", { name: "Add Skill" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Skill name")).toHaveAttribute(
      "placeholder",
      "Production deployment conventions"
    );
    expect(within(dialog).getByLabelText("Skill description")).toHaveAttribute(
      "placeholder",
      "When the agent should use this skill"
    );
    expect(within(dialog).getByLabelText("Skill instructions")).toHaveAttribute(
      "placeholder",
      "Describe the workflow, rules, constraints, and examples the agent should follow."
    );
    const fields = within(dialog).getAllByRole("textbox");
    await user.type(fields[0]!, "Acme deploy");
    await user.type(fields[1]!, "Deployment rules");
    await user.type(fields[2]!, "Follow the production checklist.");
    await user.click(within(dialog).getByRole("button", { name: "Add Skill" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Acme deploy",
        description: "Deployment rules",
        instructions: "Follow the production checklist.",
        enabled: true,
      })
    );
  });

  it("shows the shared empty state and keeps system skills collapsed without user skills", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAISkills).mockResolvedValue([SYSTEM_SKILL]);
    render(<AgentSkillsPanel />);

    expect(await screen.findByText("No custom skills configured.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add one" })).toBeEnabled();
    const systemSkillsButton = screen.getByRole("button", { name: "System skills" });
    expect(systemSkillsButton).toHaveAttribute("aria-expanded", "false");
    expect(systemSkillsButton).toHaveClass("border-t", "border-border");
    expect(
      screen.queryByRole("button", { name: "Open Infrastructure operations" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "System skills" }));
    expect(screen.getByRole("button", { name: "Open Infrastructure operations" })).toBeEnabled();
  });
});
