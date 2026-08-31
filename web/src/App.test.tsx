import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
    CreatorPage: () => <main><h2>Create workspace ready</h2></main>,
  };
});

vi.mock("./pages/LibraryPage", () => ({
  LibraryPage: () => <main><h2>Library ready</h2></main>,
}));

vi.mock("./pages/VideoPage", () => ({
  VideoPage: () => <main><h2>Video ready</h2></main>,
}));

describe("App routing", () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockResolvedValue({ email: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
    ).toBe("/");
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledOnce());
  });

  it("shows an accessible fallback while a route module loads", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading Carpo…");
    expect(
      await screen.findByRole("heading", { name: "Create workspace ready" }),
    ).toBeTruthy();
  });
});
