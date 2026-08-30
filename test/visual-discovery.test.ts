import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { AuthenticatedUser } from "../src/identity";
import { handleRequest } from "../src/routes";
import {
  analyzeVisualFrame,
  createVisualDiscovery,
  type SampledVisualFrame,
  type VisualFrameAnalysis,
} from "../src/visual-discovery";

interface Owner {
  id: string;
  email: string;
}

async function installOwner(label: string): Promise<Owner> {
  const owner = {
    id: crypto.randomUUID(),
    email: `${label}-${crypto.randomUUID()}@example.com`,
  };
  await env.DB.prepare(
    `INSERT INTO app_users (id, access_user_id, email) VALUES (?, ?, ?)`,
  )
    .bind(owner.id, owner.id, owner.email)
    .run();
  return owner;
}

async function installUpload(owner: Owner, title: string): Promise<{
  videoId: string;
  sourceKey: string;
}> {
  const videoId = crypto.randomUUID();
  const sourceKey = `uploads/${owner.id}/${videoId}.mp4`;
  await env.CLIPS_BUCKET.put(sourceKey, new Uint8Array([0, 0, 0, 1]), {
    httpMetadata: { contentType: "video/mp4" },
  });
  await env.DB.prepare(
    `INSERT INTO source_videos (
       id, owner_id, source_type, source_ref, title, duration_seconds
     ) VALUES (?, ?, 'upload', ?, ?, 16)`,
  )
    .bind(videoId, owner.id, sourceKey, title)
    .run();
  return { videoId, sourceKey };
}

async function requestAs(
  owner: Owner,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleRequest(
    new Request(`http://example.com${path}`, init),
    env,
    ctx,
    owner as AuthenticatedUser,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function fixtureDiscovery(
  analyze: (frame: SampledVisualFrame) => VisualFrameAnalysis,
) {
  const sampleFrames = vi.fn(
    async (
      testEnv: Env,
      input: { samples: SampledVisualFrame[] },
    ): Promise<void> => {
      for (const frame of input.samples) {
        await testEnv.CLIPS_BUCKET.put(
          frame.key,
          new Uint8Array([0xff, 0xd8, frame.timestampSeconds, 0xff, 0xd9]),
          { httpMetadata: { contentType: "image/jpeg" } },
        );
      }
    },
  );
  const analyzeFrame = vi.fn(
    async (_testEnv: Env, input: { frame: SampledVisualFrame }) =>
      analyze(input.frame),
  );
  return {
    discovery: createVisualDiscovery({
      sampleFrames,
      analyzeFrame,
      randomId: () => crypto.randomUUID(),
    }),
    sampleFrames,
    analyzeFrame,
  };
}

const notMatched: VisualFrameAnalysis = {
  matched: false,
  confidence: "high",
  uncertainty: "No logo is visible.",
  rationale: "The frame does not contain the fixture logo.",
  model: "fixture-vision",
};

describe("visual discovery", () => {
  it("keeps enough completion budget for a complete visual JSON result", async () => {
    const run = vi.fn(async (_model: string, request: { max_completion_tokens?: number }) => ({
      choices: [
        {
          message: {
            content:
              (request.max_completion_tokens ?? 0) >= 512
                ? '{"matched":true,"confidence":"high","uncertainty":"None.","rationale":"A red square is centered on blue."}'
                : '{"matched": true, "confidence": "high", "uncertainty": "none", "rationale": "The image contains a large, bright',
          },
        },
      ],
    }));
    const testEnv = {
      AI: { run },
      CLIPS_BUCKET: {
        get: vi.fn(async () => ({
          arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
        })),
      },
    } as unknown as Env;

    await expect(
      analyzeVisualFrame(testEnv, {
        query: "large bright red square centered on blue",
        frame: { id: "frame-1", timestampSeconds: 1, key: "frame-1.jpg" },
      }),
    ).resolves.toMatchObject({ matched: true, confidence: "high" });
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max_completion_tokens: 512 }),
    );
  });

  it("finds a repository-owned logo fixture with bounded sampled evidence", async () => {
    const owner = await installOwner("visual-logo");
    const { videoId } = await installUpload(owner, "Logo fixture");
    const { discovery, sampleFrames, analyzeFrame } = fixtureDiscovery((frame) =>
      frame.timestampSeconds >= 5 && frame.timestampSeconds <= 11
        ? {
            matched: true,
            confidence: "high",
            uncertainty: "The logo edges are fully visible.",
            rationale: "The blue CARPO fixture logo is centered in the frame.",
            model: "fixture-vision",
          }
        : notMatched,
    );

    const response = await discovery.view(env, owner.id, {
      videoId,
      query: "find every time the blue CARPO logo appears",
    });

    expect(response.sampledFrameCount).toBe(8);
    expect(response.coverageMessage).toMatch(/may be missed/i);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      videoId,
      sourceRevision: expect.stringMatching(/^source-/),
      proposedRange: { startSeconds: 4, endSeconds: 12 },
    });
    expect(response.results[0].evidence).toHaveLength(4);
    expect(response.results[0].evidence[0]).toMatchObject({
      frameUrl: expect.stringMatching(/^\/api\/visual-evidence\//),
      confidence: "high",
    });
    expect(sampleFrames).toHaveBeenCalledTimes(1);
    expect(analyzeFrame).toHaveBeenCalledTimes(8);

    await discovery.view(env, owner.id, {
      videoId,
      query: "find every time the blue CARPO logo appears",
    });
    expect(sampleFrames).toHaveBeenCalledTimes(1);
    expect(analyzeFrame).toHaveBeenCalledTimes(8);
  });

  it("prepares only an unchanged owner-bound result for editable review", async () => {
    const alice = await installOwner("visual-alice");
    const bob = await installOwner("visual-bob");
    const { videoId } = await installUpload(alice, "Private visual fixture");
    const { discovery } = fixtureDiscovery((frame) =>
      frame.timestampSeconds === 7 ? {
        matched: true,
        confidence: "medium",
        uncertainty: "The mark is partly occluded.",
        rationale: "A likely logo is visible.",
        model: "fixture-vision",
      } : notMatched,
    );
    const search = await discovery.view(env, alice.id, {
      videoId,
      query: "the logo",
    });
    const result = search.results[0];

    await expect(
      discovery.perform(env, bob.id, {
        resultId: result.resultId,
        query: result.query,
        videoId,
        sourceRevision: result.sourceRevision,
        observationIds: result.evidence.map(({ observationId }) => observationId),
        startSeconds: result.proposedRange.startSeconds,
        endSeconds: result.proposedRange.endSeconds,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });

    const prepared = await discovery.perform(env, alice.id, {
      resultId: result.resultId,
      query: result.query,
      videoId,
      sourceRevision: result.sourceRevision,
      observationIds: result.evidence.map(({ observationId }) => observationId),
      startSeconds: result.proposedRange.startSeconds,
      endSeconds: result.proposedRange.endSeconds,
    });
    expect(prepared.reviewUrl).toContain("visualProposal=");
    expect(prepared.input).toMatchObject({ startSeconds: 6, endSeconds: 8 });
    expect(await discovery.dossier(env, alice.id, prepared.proposalId)).toMatchObject({
      proposalId: prepared.proposalId,
      videoId,
    });
  });

  it("invalidates cached observations when uploaded source bytes change", async () => {
    const owner = await installOwner("visual-revision");
    const { videoId, sourceKey } = await installUpload(owner, "Mutable fixture");
    const { discovery, sampleFrames, analyzeFrame } = fixtureDiscovery(() => notMatched);
    const first = await discovery.view(env, owner.id, { videoId, query: "logo" });

    await env.CLIPS_BUCKET.put(sourceKey, new Uint8Array([9, 8, 7, 6, 5]), {
      httpMetadata: { contentType: "video/mp4" },
    });
    const second = await discovery.view(env, owner.id, { videoId, query: "logo" });

    expect(second.sourceRevision).not.toBe(first.sourceRevision);
    expect(sampleFrames).toHaveBeenCalledTimes(2);
    expect(analyzeFrame).toHaveBeenCalledTimes(16);
    const stale = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM visual_frame_observations
       WHERE video_id = ? AND source_revision = ?`,
    )
      .bind(videoId, first.sourceRevision)
      .first<{ count: number }>();
    expect(stale?.count).toBe(0);
  });

  it("serves sampled frames only to the owner and deletes them with the video", async () => {
    const alice = await installOwner("visual-evidence-alice");
    const bob = await installOwner("visual-evidence-bob");
    const { videoId } = await installUpload(alice, "Private evidence");
    const frameKey = `visual-samples/${alice.id}/${videoId}/source-fixture/frame-00.jpg`;
    const observationId = crypto.randomUUID();
    await env.CLIPS_BUCKET.put(frameKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      httpMetadata: { contentType: "image/jpeg" },
    });
    await env.DB.prepare(
      `INSERT INTO visual_frame_observations (
         id, owner_id, video_id, source_revision, query_hash, query,
         sampled_at_seconds, frame_key, matched, confidence, uncertainty,
         rationale, model
       ) VALUES (?, ?, ?, 'source-fixture', 'query-fixture', 'logo', 1, ?, 1,
         'high', 'None', 'Fixture logo', 'fixture-vision')`,
    )
      .bind(observationId, alice.id, videoId, frameKey)
      .run();

    expect((await requestAs(bob, `/api/visual-evidence/${observationId}`)).status).toBe(404);
    const owned = await requestAs(alice, `/api/visual-evidence/${observationId}`);
    expect(owned.status).toBe(200);
    expect(owned.headers.get("Cache-Control")).toBe("private, no-store");

    expect((await requestAs(alice, `/api/videos/${videoId}`, { method: "DELETE" })).status).toBe(204);
    expect(await env.CLIPS_BUCKET.head(frameKey)).toBeNull();
  });
});
