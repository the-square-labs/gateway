import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useUrlTab } from "./use-url-tab";

function DeferredResourceTabs() {
  const [validTabs, setValidTabs] = useState(["details"]);
  const [activeTab] = useUrlTab(validTabs, "details", (tab) => `/resource/${tab}`);
  return (
    <>
      <div data-testid="active-tab">{activeTab}</div>
      <button type="button" onClick={() => setValidTabs(["details", "secure-link"])}>
        Load resource
      </button>
    </>
  );
}

describe("useUrlTab", () => {
  it("restores a URL tab that becomes valid after resource loading", () => {
    render(
      <MemoryRouter initialEntries={["/resource/secure-link"]}>
        <Routes>
          <Route path="/resource/:tab?" element={<DeferredResourceTabs />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("active-tab")).toHaveTextContent("details");
    fireEvent.click(screen.getByRole("button", { name: "Load resource" }));
    expect(screen.getByTestId("active-tab")).toHaveTextContent("secure-link");
  });
});
