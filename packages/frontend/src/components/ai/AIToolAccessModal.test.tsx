import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { waitForReveal } from "@/test/reveal";
import { AIToolAccessModal } from "./AIToolAccessModal";

type ToolCatalog = Awaited<ReturnType<typeof api.getAITools>>;

const catalog = {
  Docker: [
    {
      name: "restart_docker_container",
      displayName: "Restart container",
      displayDescription: "Restart a Docker container",
      destructive: true,
      requiredScope: "docker:containers:manage",
    },
  ],
} as unknown as ToolCatalog;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function renderModal() {
  return render(
    <AIToolAccessModal open onOpenChange={vi.fn()} disabledTools={[]} onSave={vi.fn()} />
  );
}

describe("AIToolAccessModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens with the tool list in place instead of an empty list that fills in", async () => {
    const request = deferred<ToolCatalog>();
    vi.spyOn(api, "getAITools").mockReturnValue(request.promise);

    renderModal();

    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-reveal-phase", "revealed");

    await act(async () => request.resolve(catalog));
    await waitForReveal();

    expect(screen.getByText("Restart container")).toBeInTheDocument();
    expect(screen.getByText("(requires approval)")).toHaveClass("text-xs");
    expect(screen.getByText("1 of 1 tool enabled")).toBeInTheDocument();
    expect(screen.queryByText("No tools found.")).not.toBeInTheDocument();
  });

  it("still opens when the tool list cannot be loaded", async () => {
    const request = deferred<ToolCatalog>();
    vi.spyOn(api, "getAITools").mockReturnValue(request.promise);

    renderModal();
    await act(async () => request.reject(new Error("offline")));
    await waitForReveal();

    expect(screen.getByText("No tools found.")).toBeInTheDocument();
  });
});
