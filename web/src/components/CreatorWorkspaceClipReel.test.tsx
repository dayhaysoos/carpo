import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedUploadClipJourneyView } from "../owned-upload-clip-journey";
import type { ClipResponse } from "../types";
import {
  CreatorWorkspaceClipPreview,
  CreatorWorkspaceClipReel,
  getCreatorWorkspaceClipItems,
  type CreatorWorkspaceClipItem,
} from "./CreatorWorkspaceClipReel";

afterEach(cleanup);

function clip(
  id: string,
  overrides: Partial<ClipResponse> = {},
): ClipResponse {
  const base: ClipResponse = {
    id,
    videoId: "video-1",
    title: `Clip ${id}`,
    source: { type: "upload", key: "uploads/source.mp4" },
    trimStart: 4,
    trimEnd: 16.5,
    quality: "1080p",
    caption: null,
    filters: [],
    status: "complete",
    errorMessage: null,
    gifStatus: "none",
    gifErrorMessage: null,
    outputs: {
      mp4: `/clips/${id}.mp4`,
      thumbnail: `/clips/${id}.jpg`,
      gif: null,
    },
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:01:00.000Z",
  };

  return {
    ...base,
    ...overrides,
    outputs: {
      ...base.outputs,
      ...overrides.outputs,
    },
  };
}

function journey(
  createdClip: OwnedUploadClipJourneyView["createdClip"],
): OwnedUploadClipJourneyView {
  return {
    sourceVideoId: "video-1",
    phase: createdClip?.status === "failed" ? "failed" : "rendering",
    clip: null,
    createdClip,
  };
}

function item(
  fullClip: ClipResponse | null,
  overrides: Partial<CreatorWorkspaceClipItem> = {},
): CreatorWorkspaceClipItem {
  return {
    id: fullClip?.id ?? "optimistic-1",
    title: fullClip?.title ?? "Optimistic clip",
    status: fullClip?.status ?? "encoding",
    clip: fullClip,
    thumbnailUrl: fullClip?.outputs.thumbnail ?? "/source.jpg",
    durationSeconds: fullClip
      ? Math.max(0, fullClip.trimEnd - fullClip.trimStart)
      : null,
    ...overrides,
  };
}

describe("getCreatorWorkspaceClipItems", () => {
  it("merges an optimistic clip ahead of newest-first full clips and deduplicates it once full data arrives", () => {
    const older = clip("older", {
      createdAt: "2026-08-31T09:00:00.000Z",
    });
    const newer = clip("newer", {
      createdAt: "2026-08-31T11:00:00.000Z",
    });

    const withOptimistic = getCreatorWorkspaceClipItems(
      [older, newer],
      journey({
        id: "optimistic",
        title: "Just created",
        status: "queued",
      }),
      "/source.jpg",
    );

    expect(withOptimistic.map(({ id }) => id)).toEqual([
      "optimistic",
      "newer",
      "older",
    ]);
    expect(withOptimistic[0]).toMatchObject({
      title: "Just created",
      clip: null,
      thumbnailUrl: "/source.jpg",
      durationSeconds: null,
    });

    const deduplicated = getCreatorWorkspaceClipItems(
      [older, newer],
      journey({ id: older.id, title: older.title, status: older.status }),
      "/source.jpg",
    );

    expect(deduplicated.map(({ id }) => id)).toEqual(["newer", "older"]);
    expect(deduplicated.filter(({ id }) => id === older.id)).toHaveLength(1);
    expect(deduplicated[1]?.clip).toBe(older);
  });

  it("uses the source thumbnail when a full clip has no generated thumbnail", () => {
    const fullClip = clip("without-thumbnail", {
      outputs: { mp4: "/clips/without-thumbnail.mp4", thumbnail: null, gif: null },
    });

    const [result] = getCreatorWorkspaceClipItems(
      [fullClip],
      journey(null),
      "/source.jpg",
    );

    expect(result?.thumbnailUrl).toBe("/source.jpg");
  });
});

describe("CreatorWorkspaceClipReel", () => {
  it("exposes compact status and duration context and reports the selected row trigger", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const fullClip = clip("ready", {
      title: "Launch highlight",
      trimStart: 1.25,
      trimEnd: 13.75,
    });
    const ready = item(fullClip);

    render(
      <CreatorWorkspaceClipReel
        items={[ready]}
        selectedClipId={null}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("1 clip")).toBeTruthy();
    expect(screen.getByText("0:12.500")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();

    const row = screen.getByRole("button", {
      name: "Preview Launch highlight, Complete",
    });
    expect(row.getAttribute("aria-pressed")).toBe("false");

    await user.click(row);

    expect(onSelect).toHaveBeenCalledWith("ready", row);
  });
});

describe("CreatorWorkspaceClipPreview", () => {
  it("plays and downloads a complete clip and closes on request", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fullClip = clip("complete", { title: "Finished cut" });

    render(
      <CreatorWorkspaceClipPreview item={item(fullClip)} onClose={onClose} />,
    );

    expect(
      screen.getByLabelText("Finished cut video").getAttribute("src"),
    ).toBe("/clips/complete.mp4");
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href"))
      .toBe("/clips/complete.mp4?download=1");

    await user.click(screen.getByRole("button", { name: "Close clip preview" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a failed clip's recovery message and upload action", () => {
    const failedClip = clip("failed", {
      title: "Blocked source cut",
      status: "failed",
      errorMessage: "The remote source could not be downloaded.",
      sourceFailure: {
        provider: "youtube",
        code: "rate_limited",
        message: "YouTube temporarily blocked this import.",
        retryable: true,
        recovery: {
          type: "upload",
          href: "/?source=upload",
          label: "Upload your own copy",
        },
      },
      outputs: { mp4: null, thumbnail: null, gif: null },
    });

    render(
      <MemoryRouter>
        <CreatorWorkspaceClipPreview
          item={item(failedClip, { thumbnailUrl: "/source.jpg" })}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("YouTube temporarily blocked this import.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Upload your own copy" }).getAttribute("href"),
    ).toBe("/?source=upload");
    expect(screen.getByText(/retry the import later/i)).toBeTruthy();
  });
});
