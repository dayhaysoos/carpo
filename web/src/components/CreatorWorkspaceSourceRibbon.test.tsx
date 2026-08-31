import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorWorkspaceSourceRibbon } from "./CreatorWorkspaceSourceRibbon";

describe("CreatorWorkspaceSourceRibbon", () => {
  afterEach(cleanup);

  it("presents the active source and delegates choosing another video", async () => {
    const user = userEvent.setup();
    const onChooseAnother = vi.fn();

    render(
      <CreatorWorkspaceSourceRibbon
        source={{
          title: "I turned my viewer into a one above all strategist",
          sourceType: "youtube",
          durationSeconds: 768,
          thumbnailUrl: "/api/videos/source-video/thumbnail",
        }}
        onChooseAnother={onChooseAnother}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Active source" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Thumbnail for I turned my viewer into a one above all strategist",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("I turned my viewer into a one above all strategist"),
    ).toBeTruthy();
    expect(
      screen.getByText("YouTube source · 12:48 · private workspace"),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Choose another video" }),
    );
    expect(onChooseAnother).toHaveBeenCalledOnce();
  });

  it("keeps uploaded sources understandable without a thumbnail or duration", () => {
    render(
      <CreatorWorkspaceSourceRibbon
        source={{
          title: "Workshop recording",
          sourceType: "upload",
          durationSeconds: null,
          thumbnailUrl: null,
        }}
        onChooseAnother={() => {}}
      />,
    );

    expect(screen.getByText("Uploaded source · private workspace")).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: /Workshop recording/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose another video" }),
    ).toBeTruthy();
  });
});
