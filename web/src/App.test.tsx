import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "./api";
import { App } from "./App";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  getCurrentUser: vi.fn(),
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
});
