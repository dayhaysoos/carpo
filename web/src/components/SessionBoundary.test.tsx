import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "../api";
import { requireSession, SessionRequiredError } from "../session-fetch";
import { SessionBoundary } from "./SessionBoundary";
import { ModalDialog } from "./ModalDialog";

vi.mock("../api", () => ({ getCurrentUser: vi.fn() }));
const alice = { id: "alice", email: "alice@example.com" };
function Draft() {
  const [text, setText] = useState("");
  return (
    <input
      aria-label="Draft"
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}
function renderWorkspace() {
  return render(
    <StrictMode>
      <SessionBoundary>
        {(user) => (
          <>
            <p>{user.email}</p>
            <Draft />
          </>
        )}
      </SessionBoundary>
    </StrictMode>,
  );
}
beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue(alice);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("private workspace session", () => {
  it("pauses portaled dialogs and preserves their drafts after same-account recovery", async () => {
    render(
      <SessionBoundary>
        {() => (
          <ModalDialog labelledBy="draft-title">
            <h2 id="draft-title">Caption draft</h2>
            <Draft />
          </ModalDialog>
        )}
      </SessionBoundary>,
    );
    fireEvent.change(await screen.findByLabelText("Draft"), {
      target: { value: "Keep my caption correction" },
    });
    act(() => { requireSession(); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".modal-backdrop")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check session again" }));
    expect(await screen.findByRole("dialog", { name: "Caption draft" })).toBeTruthy();
    expect(screen.getByLabelText("Draft")).toHaveProperty("value", "Keep my caption correction");
  });
  it("withholds the workspace until the identity is known", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new SessionRequiredError());
    renderWorkspace();
    expect(screen.queryByLabelText("Draft")).toBeNull();
    expect(
      await screen.findByRole("link", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(screen.queryByText(alice.email)).toBeNull();
  });
  it("keeps a same-account draft through expiry and reauthentication", async () => {
    renderWorkspace();
    fireEvent.change(await screen.findByLabelText("Draft"), {
      target: { value: "Keep this moment" },
    });
    act(() => {
      requireSession();
    });
    expect(
      screen.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Sign in again (new tab)" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe(
      "/auth/login?returnTo=%2Fauth%2Frefresh",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check session again" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Pick up where you left off." }),
      ).toBeNull(),
    );
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
      "Keep this moment",
    );
  });
  it("discards the previous account's draft when the signed-in account changes", async () => {
    renderWorkspace();
    fireEvent.change(await screen.findByLabelText("Draft"), {
      target: { value: "Alice private draft" },
    });
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: "bob",
      email: "bob@example.com",
    });
    fireEvent.focus(window);
    expect(await screen.findByText("bob@example.com")).toBeTruthy();
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(alice.email)).toBeNull();
  });
  it("recovers from a failed identity check without showing a signed-in screen", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(
      new Error("Connection unavailable"),
    );
    renderWorkspace();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Connection unavailable",
    );
    expect(screen.queryByLabelText("Draft")).toBeNull();
    vi.mocked(getCurrentUser).mockResolvedValue(alice);
    fireEvent.click(
      screen.getByRole("button", { name: "Check session again" }),
    );
    expect(await screen.findByLabelText("Draft")).toBeTruthy();
  });
});
