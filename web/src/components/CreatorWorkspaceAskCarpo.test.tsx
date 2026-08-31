import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CreatorWorkspaceAskCarpo } from "./CreatorWorkspaceAskCarpo";

afterEach(cleanup);

function StatefulConversation() {
  const [messages, setMessages] = useState(0);

  return (
    <div data-testid="conversation">
      <span>{messages} messages</span>
      <button type="button" onClick={() => setMessages((count) => count + 1)}>
        Add message
      </button>
    </div>
  );
}

describe("CreatorWorkspaceAskCarpo", () => {
  it("keeps the conversation mounted while presenting it as a closed secondary drawer", async () => {
    const user = userEvent.setup();
    render(
      <CreatorWorkspaceAskCarpo>
        <StatefulConversation />
      </CreatorWorkspaceAskCarpo>,
    );

    const trigger = screen.getByRole("button", { name: "Ask Carpo" });
    const drawer = screen.getByTestId("conversation").closest("aside");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(drawer?.getAttribute("data-state")).toBe("closed");
    expect(screen.getByTestId("conversation")).toBeTruthy();

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Ask Carpo" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close Ask Carpo" }),
      ),
    );
  });

  it("preserves child state and restores trigger focus after close and Escape", async () => {
    const user = userEvent.setup();
    render(
      <CreatorWorkspaceAskCarpo>
        <StatefulConversation />
      </CreatorWorkspaceAskCarpo>,
    );

    const trigger = screen.getByRole("button", { name: "Ask Carpo" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Add message" }));
    await user.click(screen.getByRole("button", { name: "Close Ask Carpo" }));

    expect(screen.getByText("1 messages")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    expect(screen.getByText("1 messages")).toBeTruthy();
    await user.keyboard("{Escape}");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
