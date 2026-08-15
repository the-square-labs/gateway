import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { composerAttachmentToFile, useAIComposerDraft } from "./useAIComposerDraft";

describe("useAIComposerDraft", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: { id: "user-1" } } as never);
  });

  it("keeps a new-chat draft when the first conversation snapshot assigns an id", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) => useAIComposerDraft(conversationId),
      { initialProps: { conversationId: null as string | null } }
    );

    act(() => result.current[1]("Draft that must survive the snapshot"));
    rerender({ conversationId: "conversation-1" });

    expect(result.current[0]).toBe("Draft that must survive the snapshot");
    expect(localStorage.getItem("gateway-ai-composer-draft:user-1:new")).toBeNull();
  });

  it("does not resurrect a cleared draft after reload", () => {
    const firstMount = renderHook(
      ({ conversationId }: { conversationId: string | null }) => useAIComposerDraft(conversationId),
      { initialProps: { conversationId: null as string | null } }
    );

    act(() => firstMount.result.current[1]("text 1"));
    firstMount.rerender({ conversationId: "conversation-1" });
    act(() => firstMount.result.current[1](""));
    firstMount.unmount();

    const reloaded = renderHook(() => useAIComposerDraft("conversation-1"));
    expect(reloaded.result.current[0]).toBe("");
    expect(localStorage.getItem("gateway-ai-composer-draft:user-1:new")).toBeNull();
    expect(localStorage.getItem("gateway-ai-composer-draft:user-1:conversation-1")).toBeNull();
  });
});

describe("composerAttachmentToFile", () => {
  it("decodes a persisted data URL without making a network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const file = await composerAttachmentToFile({
      localId: "local-1",
      filename: "pixel.png",
      mediaType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
      previewUrl: "data:image/png;base64,AQID",
      kind: "image",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(file.name).toBe("pixel.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });
});
