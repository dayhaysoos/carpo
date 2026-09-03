import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "./api";
import { App } from "./App";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  getCurrentUser: vi.fn(),
}));

vi.mock("./pages/CreatorPage", async () => {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return {
    CreatorPage: () => (
      <main>
        <h2>Create workspace ready</h2>
      </main>
    ),
  };
});

vi.mock("./pages/LibraryPage", () => ({
  LibraryPage: () => (
    <main>
      <h2>Library ready</h2>
    </main>
  ),
}));

vi.mock("./pages/VideoPage", () => ({
  VideoPage: () => (
    <main>
      <h2>Video ready</h2>
    </main>
  ),
}));

function RouteProbe() {
  const location = useLocation();
  return (
    <output aria-label="Current route">
      {location.pathname + location.search}
    </output>
  );
}

describe("App routing", () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "legacy", email: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the public landing page without an identity request", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Your video. More moments." }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Start clipping" }).getAttribute("href"),
    ).toBe("/sign-in");
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("gives unknown routes a clear recovery path", async () => {
    render(
      <MemoryRouter initialEntries={["/__carpo-review-missing"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "That page isn’t here." }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Library" }).getAttribute("href"),
    ).toBe("/library");
    expect(
      screen.getByRole("link", { name: "Create a clip" }).getAttribute("href"),
    ).toBe("/create");
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("shows an accessible fallback while a route module loads", async () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Checking your session…",
    );
    expect(
      await screen.findByRole("heading", { name: "Create workspace ready" }),
    ).toBeTruthy();
  });

  it("preserves old source and proposal handoffs at the new editor route", async () => {
    render(
      <MemoryRouter
        initialEntries={["/?video=source-1&libraryProposal=proposal-1"]}
      >
        <App />
        <RouteProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Create workspace ready" });
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/create?video=source-1&libraryProposal=proposal-1",
    );
  });

  it("offers Google sign-in without provisioning a workspace on the public entry", () => {
    render(
      <MemoryRouter initialEntries={["/sign-in?returnTo=%2Flibrary"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen
        .getByRole("link", { name: "Continue with Google" })
        .getAttribute("href"),
    ).toBe("/api/auth/login?returnTo=%2Flibrary");
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
});
