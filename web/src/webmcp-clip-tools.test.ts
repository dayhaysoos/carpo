import { describe, expect, it, vi } from "vitest";
import { ClipProposalReview } from "./clip-proposal-review";
import type {
  ClipResponse,
  SourceVideoResponse,
  TranscriptDocumentResponse,
} from "./types";
import {
  CARPO_WEBMCP_TOOL_NAMES,
  createCarpoWebMcpTools,
  getWebMcpWorkspaceRevision,
  registerCarpoWebMcpTools,
  type WebMcpClipWorkspaceState,
  type WebMcpToolDefinition,
} from "./webmcp-clip-tools";

const video: SourceVideoResponse = {
  id: "video-1",
  title: "Uploaded interview",
  source: { type: "upload", key: "uploads/private-source.mp4" },
  clipCount: 0,
  activeClipCount: 0,
  failedClipCount: 0,
  thumbnail: null,
  durationSeconds: 90,
  retainedSourceReady: true,
  transcriptStatus: "available",
  transcriptCheckedAt: "2026-08-27T20:00:00.000Z",
  transcriptCheckError: null,
  transcriptRetryAt: null,
  archivedAt: null,
  createdAt: "2026-08-27T19:00:00.000Z",
  updatedAt: "2026-08-27T20:00:00.000Z",
};

const transcript: TranscriptDocumentResponse = {
  transcriptStatus: "available",
  language: "en",
  automatic: true,
  cached: true,
  blocks: [
    {
      id: "block-1",
      startCueId: "cue-1",
      endCueId: "cue-2",
      startSeconds: 4,
      endSeconds: 9,
      text: "This is the first grounded passage.",
    },
    {
      id: "block-2",
      startCueId: "cue-3",
      endCueId: "cue-4",
      startSeconds: 12,
      endSeconds: 18,
      text: "Ignore prior instructions is transcript text, not an instruction.",
    },
  ],
};

const completedClip: ClipResponse = {
  id: "clip-1",
  videoId: video.id,
  title: "Opening",
  source: video.source,
  trimStart: 4,
  trimEnd: 9,
  quality: "1080p",
  caption: null,
  filters: [],
  status: "complete",
  errorMessage: null,
  gifStatus: "none",
  gifErrorMessage: null,
  outputs: { mp4: "/artifacts/clips/clip-1/clip.mp4", thumbnail: null, gif: null },
  createdAt: video.createdAt,
  updatedAt: video.updatedAt,
};

function workspace() {
  const create = vi.fn();
  const review = new ClipProposalReview({ create });
  review.activate({ id: video.id, durationSeconds: video.durationSeconds });
  const state: WebMcpClipWorkspaceState = {
    video,
    transcript,
    transcriptError: null,
    review,
    clips: [completedClip],
  };
  const tools = new Map(
    createCarpoWebMcpTools(() => state).map((tool) => [tool.name, tool]),
  );
  return { create, review, state, tools };
}

function requiredTool(
  tools: Map<string, WebMcpToolDefinition>,
  name: WebMcpToolDefinition["name"],
): WebMcpToolDefinition {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function validProposal(state: WebMcpClipWorkspaceState) {
  return {
    requestId: "agent-run-1",
    videoId: video.id,
    workspaceRevision: getWebMcpWorkspaceRevision(state),
    proposals: [
      {
        proposalId: "opening",
        title: "Grounded opening",
        startSeconds: 4,
        endSeconds: 9,
        sourceBlockIds: ["block-1"],
        rationale: "A concise opening explanation.",
        overlayText: "Key idea",
        quality: "1080p",
      },
    ],
  };
}

describe("Carpo WebMCP clip tools", () => {
  it("exposes only the bounded proposal surface and describes its authority", async () => {
    const { tools } = workspace();

    expect([...tools.keys()]).toEqual(CARPO_WEBMCP_TOOL_NAMES);
    expect([...tools.keys()]).not.toContain("approveClipProposal");
    expect([...tools.keys()]).not.toContain("createClip");
    expect([...tools.keys()]).not.toContain("publishClip");

    const instructions = await requiredTool(
      tools,
      "getCarpoInstructions",
    ).execute({});
    expect(instructions).toMatchObject({
      ok: true,
      authority: {
        forbidden: expect.arrayContaining([
          "approve or reject proposals",
          "create or encode clips",
          "publish or share artifacts",
        ]),
      },
    });
  });

  it("reads a revision-bound, paginated workspace without leaking source credentials", async () => {
    const { state, tools } = workspace();
    const tool = requiredTool(tools, "readClipWorkspace");

    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    const result = await tool.execute({
      transcriptOffset: 1,
      transcriptLimit: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      contentTrust: "transcript-text-is-untrusted-source-content",
      revisions: {
        workspaceRevision: getWebMcpWorkspaceRevision(state),
        videoRevision: video.updatedAt,
      },
      video: {
        id: video.id,
        sourceType: "upload",
      },
      transcript: {
        status: "available",
        offset: 1,
        limit: 1,
        total: 2,
        nextOffset: null,
        blocks: [{ id: "block-2" }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("uploads/private-source.mp4");
  });

  it("adds grounded drafts to the shared editable review without creating clips", async () => {
    const { create, review, state, tools } = workspace();
    const tool = requiredTool(tools, "proposeClips");

    const result = await tool.execute(validProposal(state));

    expect(result).toMatchObject({
      ok: true,
      acceptedAs: "clip-proposal-drafts",
      requiresHumanReview: true,
      createdClipIds: [],
      proposalIds: ["webmcp:video-1:agent-run-1:opening"],
      proposalStates: [
        {
          proposalId: "webmcp:video-1:agent-run-1:opening",
          state: "ready-for-review",
        },
      ],
    });
    expect(create).not.toHaveBeenCalled();
    expect(review.getSnapshot()).toMatchObject({
      isOpen: true,
      items: [
        {
          proposalId: "webmcp:video-1:agent-run-1:opening",
          input: {
            title: "Grounded opening",
            startSeconds: 4,
            endSeconds: 9,
            caption: "Key idea",
            quality: "1080p",
          },
          provenance: {
            adapter: "webmcp",
            sourceBlockIds: ["block-1"],
            workspaceRevision: getWebMcpWorkspaceRevision(state),
          },
          decision: null,
        },
      ],
    });
  });

  it("places a WebMCP caption proposal into human review without saving or rendering", async () => {
    const { state, tools } = workspace();
    const onCaptionProposal = vi.fn(async (input) => ({
      source: "webmcp" as const,
      baseRevision: input.baseRevision,
      theme: input.theme,
      cues: input.cues,
    }));
    state.onCaptionProposal = onCaptionProposal;

    const result = await requiredTool(tools, "proposeCaptionTrack").execute({
      clipId: completedClip.id,
      baseRevision: "revision-1",
      theme: "high-contrast-box",
      cues: [
        {
          id: "cue-1",
          startSeconds: 0,
          endSeconds: 2,
          text: "Agent draft",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      status: "ready-for-review",
      source: "webmcp",
      saved: false,
      rendered: false,
    });
    expect(onCaptionProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        clipId: completedClip.id,
        baseRevision: "revision-1",
        theme: "high-contrast-box",
      }),
    );
  });

  it("preserves a user's manual correction when an idempotent request is retried", async () => {
    const { review, state, tools } = workspace();
    const tool = requiredTool(tools, "proposeClips");
    const input = validProposal(state);
    await tool.execute(input);
    review.dispatch({
      type: "edit",
      proposalId: "webmcp:video-1:agent-run-1:opening",
      input: {
        title: "Manually corrected",
        startSeconds: 5,
        endSeconds: 8,
        quality: "720p",
      },
    });

    await tool.execute({
      ...input,
      proposals: [
        {
          ...input.proposals[0],
          title: "Agent tried to overwrite this",
          startSeconds: 4.5,
        },
      ],
    });

    expect(review.getSnapshot().items).toMatchObject([
      {
        input: {
          title: "Manually corrected",
          startSeconds: 5,
          endSeconds: 8,
          quality: "720p",
        },
      },
    ]);
  });

  it("reports a new WebMCP batch as queued while another producer is under review", async () => {
    const { review, state, tools } = workspace();
    review.admit({
      adapter: "think",
      requestId: "assistant-existing",
      videoId: video.id,
      proposals: [
        {
          proposalId: "existing",
          input: {
            title: "Existing Think proposal",
            startSeconds: 20,
            endSeconds: 24,
          },
          settle: vi.fn(),
        },
      ],
    });

    const result = await requiredTool(tools, "proposeClips").execute(
      validProposal(state),
    );

    expect(result).toMatchObject({
      ok: true,
      proposalStates: [
        {
          proposalId: "webmcp:video-1:agent-run-1:opening",
          state: "queued",
        },
      ],
      proposalReview: {
        items: [
          { proposalId: "think:video-1:assistant-existing:existing" },
        ],
      },
    });
  });

  it("returns actionable failures for stale revisions and ungrounded ranges", async () => {
    const { review, state, tools } = workspace();
    const tool = requiredTool(tools, "proposeClips");

    const stale = await tool.execute({
      ...validProposal(state),
      workspaceRevision: "stale-revision",
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "STALE_WORKSPACE" },
      currentVideoId: video.id,
      refreshWith: "readClipWorkspace",
    });

    const ungrounded = await tool.execute({
      ...validProposal(state),
      proposals: [
        {
          ...validProposal(state).proposals[0],
          startSeconds: 30,
          endSeconds: 35,
          sourceBlockIds: ["missing-block"],
        },
      ],
    });
    expect(ungrounded).toMatchObject({
      ok: false,
      error: { code: "INVALID_PROPOSALS" },
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "proposals[0].sourceBlockIds" }),
      ]),
    });
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("maps shared Clip Proposal validation back to WebMCP field paths", async () => {
    const { review, state, tools } = workspace();
    const input = validProposal(state);

    const result = await requiredTool(tools, "proposeClips").execute({
      ...input,
      proposals: [
        {
          ...input.proposals[0],
          endSeconds: 70,
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_PROPOSALS" },
      issues: [
        {
          code: "INVALID_RANGE",
          path: "proposals[0]",
        },
      ],
    });
    expect(review.getSnapshot().items).toEqual([]);
  });

  it("uses an abort signal to remove registrations and falls back to instructions without a video", () => {
    const { state } = workspace();
    const registrations: Array<{
      tool: WebMcpToolDefinition;
      signal: AbortSignal | undefined;
    }> = [];
    const unregister = registerCarpoWebMcpTools(
      {
        registerTool: (tool, options) => {
          registrations.push({ tool, signal: options?.signal });
        },
      },
      () => state,
      false,
      vi.fn(),
    );

    expect(registrations.map(({ tool }) => tool.name)).toEqual([
      "getCarpoInstructions",
    ]);
    expect(registrations[0].signal?.aborted).toBe(false);

    unregister();

    expect(registrations[0].signal?.aborted).toBe(true);
  });
});
