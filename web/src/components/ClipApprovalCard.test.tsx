import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipApprovalCard } from "./ClipApprovalCard";

describe("ClipApprovalCard", () => {
  afterEach(cleanup);

  it("previews the proposed clip and requires an explicit decision", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();

    render(
      <ClipApprovalCard
        approvalId="approval-123"
        input={{
          title: "PO tokens explained",
          startSeconds: 130,
          endSeconds: 148,
          caption: "How YouTube verification works",
          quality: "720p",
        }}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByRole("heading", { name: "PO tokens explained" })).toBeTruthy();
    expect(screen.getByText("2:10.000–2:28.000")).toBeTruthy();
    expect(screen.getByText("18 seconds")).toBeTruthy();
    expect(screen.getByText("How YouTube verification works")).toBeTruthy();
    expect(screen.getByText("720p")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Create clip" }));
    expect(onDecision).toHaveBeenCalledWith("approval-123", true);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecision).toHaveBeenCalledWith("approval-123", false);
  });
});
