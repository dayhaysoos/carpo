import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCarpoVisualWebMcpTools } from "./webmcp-visual-tools";

const { searchVisualMoments, prepareVisualMomentReview } = vi.hoisted(() => ({
  searchVisualMoments: vi.fn(),
  prepareVisualMomentReview: vi.fn(),
}));

vi.mock("./api", () => ({ searchVisualMoments, prepareVisualMomentReview }));

function tool(name: string) {
  const found = createCarpoVisualWebMcpTools("video-1").find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

describe("visual WebMCP tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("states the sampled coverage and human authority boundary", async () => {
    const result = await tool("getCarpoVisualInstructions").execute({});
    expect(result).toMatchObject({
      ok: true,
      authority: {
        forbidden: expect.arrayContaining([
          expect.stringMatching(/approve, create, encode/i),
        ]),
      },
    });
    expect(JSON.stringify(result)).toMatch(/miss appearances/i);
  });

  it("returns private sampled evidence without creating a clip", async () => {
    searchVisualMoments.mockResolvedValue({
      videoId: "video-1",
      coverageMessage: "Checked 8 frames; other appearances may be missed.",
      results: [],
    });
    const result = await tool("searchVisualMoments").execute({ query: "logo" });
    expect(searchVisualMoments).toHaveBeenCalledWith("video-1", "logo");
    expect(result).toMatchObject({ ok: true, videoId: "video-1", results: [] });
    expect(result).not.toHaveProperty("createdClipIds");
  });

  it("only prepares an unchanged result for human review", async () => {
    const input = {
      resultId: "result-1",
      query: "logo",
      videoId: "video-1",
      sourceRevision: "source-1",
      observationIds: ["observation-1"],
      startSeconds: 2,
      endSeconds: 4,
    };
    prepareVisualMomentReview.mockResolvedValue({
      proposalId: "proposal-1",
      videoId: "video-1",
      reviewUrl: "/?video=video-1&visualProposal=proposal-1",
    });
    const result = await tool("prepareVisualMomentReview").execute(input);
    expect(prepareVisualMomentReview).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      ok: true,
      requiresHumanReview: true,
      createdClipIds: [],
    });
  });
});
