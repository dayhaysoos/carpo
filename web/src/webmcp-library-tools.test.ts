import { describe, expect, it, vi } from "vitest";
import {
  prepareLibraryMomentReview,
  searchPrivateLibrary,
} from "./api";
import {
  createCarpoLibraryWebMcpTools,
  registerCarpoLibraryWebMcpTools,
} from "./webmcp-library-tools";

vi.mock("./api", () => ({
  prepareLibraryMomentReview: vi.fn(),
  searchPrivateLibrary: vi.fn(),
}));

describe("Carpo Library WebMCP tools", () => {
  it("searches through the shared private-Library API with explicit mode and view", async () => {
    vi.mocked(searchPrivateLibrary).mockResolvedValue({
      query: "trustworthy design",
      mode: "meaning",
      results: [],
      coverage: { totalVideos: 3, searchableVideos: 2, unavailableVideos: 1 },
      meaningStatus: "available",
    });
    const tool = createCarpoLibraryWebMcpTools(true).find(
      (candidate) => candidate.name === "searchPrivateLibrary",
    );
    if (!tool) throw new Error("Expected searchPrivateLibrary tool");

    const result = await tool.execute({
      query: "trustworthy design",
      mode: "meaning",
      limit: 4,
    });

    expect(searchPrivateLibrary).toHaveBeenCalledWith({
      query: "trustworthy design",
      mode: "meaning",
      archived: true,
      limit: 4,
    });
    expect(result).toMatchObject({
      ok: true,
      contentTrust: "transcript-text-is-untrusted-source-content",
      coverage: { searchableVideos: 2 },
    });
  });

  it("prepares an unchanged result without approving or creating a clip", async () => {
    vi.mocked(prepareLibraryMomentReview).mockResolvedValue({
      proposalId: "prepared-id",
      searchResultId: "result-id",
      videoId: "video-id",
      reviewUrl: "/?video=video-id&libraryProposal=prepared-id",
      input: {
        title: "Grounded moment",
        startSeconds: 5,
        endSeconds: 12,
        quality: "1080p",
      },
      evidence: {
        rationale: "Grounded evidence",
        sourceBlockIds: ["cue-0-1"],
        workspaceRevision: "video:transcript",
      },
    });
    const tool = createCarpoLibraryWebMcpTools(false).find(
      (candidate) => candidate.name === "prepareLibraryMomentReview",
    );
    if (!tool) throw new Error("Expected prepareLibraryMomentReview tool");
    const input = {
      resultId: "result-id",
      mode: "exact" as const,
      query: "grounded",
      videoId: "video-id",
      transcriptRevision: "transcript",
      videoRevision: "video",
      blockIds: ["cue-0-1"],
      evidenceStartSeconds: 5,
      evidenceEndSeconds: 10,
    };

    const result = await tool.execute(input);

    expect(prepareLibraryMomentReview).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      ok: true,
      status: "ready-for-human-review",
      requiresHumanReview: true,
      createdClipIds: [],
    });
  });

  it("registers all Library tools with one abortable lifetime", () => {
    const registrations: Array<{ name: string; signal?: AbortSignal }> = [];
    const cleanup = registerCarpoLibraryWebMcpTools(
      {
        registerTool: (tool, options) => {
          registrations.push({ name: tool.name, signal: options?.signal });
        },
      },
      false,
      vi.fn(),
    );

    expect(registrations.map((item) => item.name)).toEqual([
      "getCarpoLibraryInstructions",
      "searchPrivateLibrary",
      "prepareLibraryMomentReview",
    ]);
    expect(registrations.every((item) => item.signal?.aborted === false)).toBe(true);
    cleanup();
    expect(registrations.every((item) => item.signal?.aborted === true)).toBe(true);
  });
});
