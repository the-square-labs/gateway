import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Markdown from "react-markdown";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AIResourceReference } from "@/types/ai";
import {
  AIChangedResources,
  resourceAwareMarkdown,
  resourceMarkdownLinkComponent,
} from "./ai-resource-links";

const containerReference: AIResourceReference = {
  refId: "gwr_0123456789abcdef01234567",
  type: "docker_container",
  resourceId: "container-1",
  label: "ai-e2e-restart",
  relation: "created",
  nodeId: "node-1",
  nodeSlug: "docker-src",
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state)}</output>;
}

describe("AI resource links", () => {
  it("renders a validated marker as a canonical internal resource link", () => {
    const content = resourceAwareMarkdown(
      "Created [[resource:gwr_0123456789abcdef01234567|527b02985e9b37cf]].",
      [containerReference]
    );
    render(
      <MemoryRouter>
        <Markdown components={{ a: resourceMarkdownLinkComponent([containerReference]) }}>
          {content}
        </Markdown>
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "Container: ai-e2e-restart" });
    expect(link).toHaveAttribute("href", "/docker/containers/docker-src/ai-e2e-restart");
    expect(link).toHaveClass("text-[color:var(--color-link)]");
  });

  it("preserves the chat route as the back target for resource navigation", async () => {
    const user = userEvent.setup();
    const content = resourceAwareMarkdown(
      "Open [[resource:gwr_0123456789abcdef01234567|ai-e2e-restart]].",
      [containerReference]
    );
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Markdown components={{ a: resourceMarkdownLinkComponent([containerReference]) }}>
          {content}
        </Markdown>
        <LocationProbe />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("link", { name: "Container: ai-e2e-restart" }));

    expect(screen.getByTestId("location-state")).toHaveTextContent('"returnTo":"/chat"');
  });

  it("uses a resource appearance color when the server provides one", () => {
    render(
      <MemoryRouter>
        <AIChangedResources
          references={[
            {
              ...containerReference,
              type: "node",
              resourceId: "node-1",
              label: "docker-src",
              slug: "docker-src",
              appearanceColor: "orange",
            },
          ]}
        />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "Node: docker-src" });
    expect(link).toHaveClass("text-orange-600");
    expect(link).not.toHaveClass("text-[color:var(--color-link)]");
  });

  it("renders an unknown marker as plain fallback text", () => {
    const content = resourceAwareMarkdown(
      "Created [[resource:gwr_fedcba9876543210fedcba98|untrusted]].",
      [containerReference]
    );
    render(<Markdown>{content}</Markdown>);

    expect(screen.getByText(/Created untrusted/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("routes deleted resources to their parent list", () => {
    render(
      <MemoryRouter>
        <AIChangedResources references={[{ ...containerReference, relation: "deleted" }]} />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "Container: ai-e2e-restart" })).toHaveAttribute(
      "href",
      "/docker/containers"
    );
  });

  it("renders modified resources as a titled chip column", () => {
    render(
      <MemoryRouter>
        <AIChangedResources references={[containerReference]} />
      </MemoryRouter>
    );

    const title = screen.getByText("Modified resources");
    expect(title.parentElement).toHaveClass("flex-col", "text-sm", "mt-3");
    expect(screen.queryByText("Changed:")).not.toBeInTheDocument();
  });

  it("routes an updated Docker volume in Modified resources to its detail page", () => {
    render(
      <MemoryRouter>
        <AIChangedResources
          references={[
            {
              ...containerReference,
              type: "docker_volume",
              resourceId: "ai-e2e-restart-data",
              label: "ai-e2e-restart-data",
              relation: "updated",
            },
          ]}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("link", { name: "Docker volume: ai-e2e-restart-data" })
    ).toHaveAttribute("href", "/docker/volumes/docker-src/ai-e2e-restart-data");
  });
});
